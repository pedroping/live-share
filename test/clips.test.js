// Clip pipeline: viewer asks, broadcaster uploads segments, server renders.
// Covers the three render paths (stream copy, audio rebuild, re-encode).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, connect, makeSegment, mediaInfo } = require('./helpers');

const SEGMENTS = path.join(os.tmpdir(), 'live-share-test-segments');
let server;
let seg;

before(async () => {
  fs.mkdirSync(SEGMENTS, { recursive: true });
  seg = {
    small: makeSegment(path.join(SEGMENTS, 'small-audio.webm')),
    smallSilent: makeSegment(path.join(SEGMENTS, 'small-noaudio.webm'), { audio: false }),
    big: makeSegment(path.join(SEGMENTS, 'big-noaudio.webm'), { width: 1280, height: 720, audio: false, pattern: 'testsrc2' }),
  };
  server = await startServer();
});
after(async () => { await server.stop(); });

// Runs one full clip round trip and returns the saved clip + file info.
async function clip(files, { duration = 12, startOffsetMs = 3000 } = {}) {
  const broadcaster = await connect(server.wsUrl);
  broadcaster.send({ type: 'create-room' });
  const { code } = await broadcaster.next('room-created');
  const viewer = await connect(server.wsUrl);
  viewer.send({ type: 'join-room', code });
  await viewer.next('joined');

  viewer.send({ type: 'clip-request', duration });
  const { requestId } = await broadcaster.next('clip-request');

  const form = new FormData();
  files.forEach((file, i) => form.append('videos', new Blob([fs.readFileSync(file)], { type: 'video/webm' }), `segmento-${i}.webm`));
  form.append('startOffsetMs', String(startOffsetMs));
  form.append('segmentDurationsMs', JSON.stringify(files.map(() => 5000)));
  const res = await fetch(`${server.base}/api/clips`, { method: 'POST', headers: { 'X-Clip-Request': requestId }, body: form });
  assert.equal(res.status, 200, await res.clone().text());
  const saved = await res.json();

  const result = await viewer.next('clip-result', 60_000);
  assert.equal(result.url, saved.url);
  assert.equal(saved.code, code);

  broadcaster.send({ type: 'end-room' });
  await viewer.close();
  await broadcaster.close();

  const file = path.join(server.dataDir, 'clips', path.basename(saved.url));
  assert.ok(fs.existsSync(file), 'clip file saved');
  assert.ok(fs.existsSync(path.join(server.dataDir, 'clips', path.basename(saved.posterUrl))), 'poster saved');
  return { saved, info: mediaInfo(file) };
}

test('matching segments are stream-copied into a WebM (no re-encode)', async () => {
  const { saved, info } = await clip([seg.small, seg.small, seg.small]);
  assert.match(saved.url, /\.webm$/);
  assert.equal(info.video, 'vp8');
  assert.equal(info.audio, 'opus');
  assert.ok(Math.abs(info.seconds - 15) < 0.5, `whole segments kept, got ${info.seconds}s`);
});

test('segments missing audio keep the video and get a rebuilt audio track', async () => {
  const { saved, info } = await clip([seg.small, seg.smallSilent, seg.small]);
  assert.match(saved.url, /\.webm$/);
  assert.equal(info.video, 'vp8');
  assert.equal(info.audio, 'opus');
});

test('segments from different sources are re-encoded to an exact-length MP4', async () => {
  const { saved, info } = await clip([seg.small, seg.big, seg.small], { duration: 12, startOffsetMs: 3000 });
  assert.match(saved.url, /\.mp4$/);
  assert.equal(info.video, 'h264');
  assert.equal(info.audio, 'aac');
  assert.ok(Math.abs(info.seconds - 12) < 0.3, `trimmed to 12s, got ${info.seconds}s`);
});

test('saved clips are listed newest first', async () => {
  const { clips } = await (await fetch(`${server.base}/api/clips`)).json();
  assert.equal(clips.length, 3);
  assert.match(clips[0].url, /\.mp4$/);
  const limited = await (await fetch(`${server.base}/api/clips?limit=1`)).json();
  assert.equal(limited.clips.length, 1);
});
