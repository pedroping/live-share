// Turns the uploaded WebM segments into one clip file plus a poster image.
//
// The broadcaster records 5-second segments, each a standalone WebM made by
// its own MediaRecorder. To make a clip it uploads the newest ones. There are
// three ways to join them, from cheapest to most expensive:
//
//   1. Stream copy        all segments match            -> .webm, no re-encode
//   2. Audio rebuild      same video, some lack audio   -> .webm, video copied
//   3. Re-encode          different sizes (the source   -> .mp4, 720p
//                         was switched mid-clip)
//
// Render's free instance has 0.1 CPU and 512 MB, and re-encoding 1080p
// crashed it, so the cheap paths matter. Copy paths keep whole segments, so
// those clips can run up to one segment (~5s) longer than asked.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { FFMPEG_PATH } = require('./config');

const DEFAULT_SEGMENT_SECONDS = 5;
const REENCODE_MAX_WIDTH = 1280;
const REENCODE_MAX_HEIGHT = 720;

// ---------------------------------------------------------------- ffmpeg

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const quietArgs = ['-y', '-hide_banner', '-loglevel', 'error', ...args];
    execFile(FFMPEG_PATH, quietArgs, { maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr.split('\n').slice(-8).join('\n')));
      else resolve();
    });
  });
}

// Codec, size and audio of a file, read from what "ffmpeg -i" prints.
function probe(file) {
  return new Promise((resolve) => {
    execFile(FFMPEG_PATH, ['-hide_banner', '-i', file], (_err, _stdout, stderr = '') => {
      const video = stderr.match(/Video: (\w+).*?(\d{2,5})x(\d{2,5})/);
      const audio = stderr.match(/Audio: (\w+)/);
      resolve({
        videoCodec: video ? video[1] : '',
        width: video ? Number(video[2]) : 0,
        height: video ? Number(video[3]) : 0,
        audioCodec: audio ? audio[1] : '',
        hasAudio: Boolean(audio),
      });
    });
  });
}

const toEven = (n) => Math.max(2, Math.floor(n / 2) * 2);
const seconds = (ms) => (ms / 1000).toFixed(3);

// Silence or the segment's own audio, normalized and cut to exactly `length`
// seconds, as one filter-graph chain ending in [label].
function audioChain(inputIndex, hasAudio, length, label) {
  return hasAudio
    ? `[${inputIndex}:a]aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=duration=${length},asetpts=PTS-STARTPTS[${label}]`
    : `anullsrc=r=48000:cl=stereo,atrim=duration=${length}[${label}]`;
}

// ffmpeg "concat demuxer" list. MediaRecorder WebMs have no duration in their
// header, so each entry carries the duration the browser measured.
function writeConcatList(listFile, files, lengths) {
  const escape = (p) => p.replace(/\\/g, '/').replace(/'/g, "'\\''");
  const lines = files.map((f, i) => `file '${escape(f.path)}'\nduration ${lengths[i]}`);
  fs.writeFileSync(listFile, lines.join('\n'));
}

// ---------------------------------------------------------------- the three paths

async function streamCopy({ listFile, output }) {
  await runFfmpeg(['-fflags', '+genpts', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', output]);
}

async function copyVideoRebuildAudio({ listFile, files, info, lengths, output }) {
  // Input 0 is the concatenated video; inputs 1..n are the segments, used only
  // for their audio (ffmpeg doesn't decode streams that aren't mapped).
  const segmentInputs = files.flatMap((f) => ['-i', f.path]);
  const chains = files.map((_, i) => audioChain(i + 1, info[i].hasAudio, lengths[i], `a${i}`));
  const join = `${files.map((_, i) => `[a${i}]`).join('')}concat=n=${files.length}:v=0:a=1[audio]`;
  await runFfmpeg([
    '-threads', '1',
    '-fflags', '+genpts', '-f', 'concat', '-safe', '0', '-i', listFile,
    ...segmentInputs,
    '-filter_complex', `${chains.join(';')};${join}`,
    '-map', '0:v', '-map', '[audio]',
    '-c:v', 'copy', '-c:a', 'libopus', '-b:a', '128k', '-shortest',
    output,
  ]);
}

async function reencode({ files, info, lengths, startOffsetMs, duration, output }) {
  const first = info.find((i) => i.width && i.height) || { width: REENCODE_MAX_WIDTH, height: REENCODE_MAX_HEIGHT };
  const scale = Math.min(1, REENCODE_MAX_WIDTH / first.width, REENCODE_MAX_HEIGHT / first.height);
  const W = toEven(first.width * scale);
  const H = toEven(first.height * scale);

  const filters = [];
  files.forEach((_, i) => {
    // Letterbox every segment to the same size and frame rate, and pad the
    // last frame so each segment lasts exactly its measured length.
    filters.push(
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p,` +
      `tpad=stop_mode=clone:stop_duration=1,trim=duration=${lengths[i]},setpts=PTS-STARTPTS[v${i}]`,
    );
    filters.push(audioChain(i, info[i].hasAudio, lengths[i], `a${i}`));
  });
  const pairs = files.map((_, i) => `[v${i}][a${i}]`).join('');
  const start = seconds(startOffsetMs);
  filters.push(`${pairs}concat=n=${files.length}:v=1:a=1[vjoined][ajoined]`);
  // Cut off the extra lead-in so the clip is exactly `duration` seconds.
  filters.push(`[vjoined]trim=start=${start}:duration=${duration},setpts=PTS-STARTPTS[vout]`);
  filters.push(`[ajoined]atrim=start=${start}:duration=${duration},asetpts=PTS-STARTPTS[aout]`);

  await runFfmpeg([
    '-threads', '1',
    ...files.flatMap((f) => ['-i', f.path]),
    '-filter_complex', filters.join(';'), '-filter_complex_threads', '1',
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-threads', '1',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    output,
  ]);
}

async function makePoster(video, poster) {
  await runFfmpeg(['-threads', '1', '-i', video, '-frames:v', '1', '-vf', 'scale=640:-2', poster]);
}

// ---------------------------------------------------------------- entry point

/**
 * @param files          uploaded segment files ({ path }), oldest first
 * @param durationsMs    measured length of each segment
 * @param startOffsetMs  extra footage at the start (trimmed when re-encoding)
 * @param duration       requested clip length in seconds
 * @param outputBase     output path without extension
 * @param poster         poster .jpg path
 * @returns the clip's file name (".webm" or ".mp4")
 */
async function renderClip({ files, durationsMs, startOffsetMs, duration, outputBase, poster }) {
  const info = await Promise.all(files.map((f) => probe(f.path)));
  const lengths = files.map((_, i) => seconds(Number(durationsMs[i]) > 0 ? Number(durationsMs[i]) : DEFAULT_SEGMENT_SECONDS * 1000));

  const sameVideo = Boolean(info[0].videoCodec) && info.every((i) =>
    i.videoCodec === info[0].videoCodec && i.width === info[0].width && i.height === info[0].height);
  const sameAudio = info.every((i) => i.audioCodec === info[0].audioCodec);
  const method = !sameVideo ? 're-encode' : sameAudio ? 'stream copy' : 'video copy + audio rebuild';
  console.log(`clip: ${files.length} segments, ${method} ` +
    JSON.stringify(info.map((i) => `${i.videoCodec} ${i.width}x${i.height} ${i.audioCodec || 'no-audio'}`)));

  let output;
  if (sameVideo) {
    output = `${outputBase}.webm`;
    const listFile = `${outputBase}.txt`;
    writeConcatList(listFile, files, lengths);
    try {
      if (sameAudio) await streamCopy({ listFile, output });
      else await copyVideoRebuildAudio({ listFile, files, info, lengths, output });
    } finally {
      fs.rm(listFile, { force: true }, () => {});
    }
  } else {
    output = `${outputBase}.mp4`;
    await reencode({ files, info, lengths, startOffsetMs, duration, output });
  }

  await makePoster(output, poster);
  return path.basename(output);
}

// One clip at a time, so two requests never compete for the tiny server.
let queue = Promise.resolve();
function renderClipQueued(options) {
  const job = queue.then(() => renderClip(options), () => renderClip(options));
  queue = job.catch(() => {});
  return job;
}

module.exports = { renderClip: renderClipQueued };
