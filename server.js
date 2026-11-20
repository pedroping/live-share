const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const express = require('express');
const multer = require('multer');
const { WebSocketServer, WebSocket } = require('ws');
const ffmpegPath = process.env.FFMPEG_PATH || require('ffmpeg-static');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CLIPS_DIR = path.join(DATA_DIR, 'clips');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const INDEX_FILE = path.join(DATA_DIR, 'clips.json');
const CLIP_REQUEST_TIMEOUT_MS = 240_000;
const MAX_CLIP_SECONDS = 60;

for (const dir of [DATA_DIR, CLIPS_DIR, TMP_DIR]) fs.mkdirSync(dir, { recursive: true });

// ---------- clip index (simple JSON file) ----------
function readClips() {
  try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { return []; }
}
function addClip(clip) {
  const clips = readClips();
  clips.unshift(clip);
  fs.writeFileSync(INDEX_FILE, JSON.stringify(clips, null, 2));
}

// ---------- rooms & signaling state ----------
const rooms = new Map();          // code -> { broadcaster: ws, viewers: Map<viewerId, ws> }
const clipRequests = new Map();   // requestId -> { viewer: ws, code, duration, timer }
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

function newRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function failClipRequest(requestId, message) {
  const req = clipRequests.get(requestId);
  if (!req) return;
  clearTimeout(req.timer);
  clipRequests.delete(requestId);
  send(req.viewer, { type: 'clip-error', requestId, message });
}

// ---------- HTTP ----------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(CLIPS_DIR, { maxAge: '7d' }));

app.get('/healthz', (req, res) => res.send('ok'));

app.get('/api/clips', (req, res) => {
  const limit = Math.max(0, parseInt(req.query.limit, 10) || 0);
  const clips = readClips();
  res.json({ clips: limit ? clips.slice(0, limit) : clips });
});

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 200 * 1024 * 1024, files: 40 },
});

app.post('/api/clips', upload.array('videos', 40), async (req, res) => {
  const files = req.files || [];
  const cleanup = () => files.forEach((f) => fs.rm(f.path, { force: true }, () => {}));
  const requestId = req.get('X-Clip-Request');
  const pending = clipRequests.get(requestId);

  if (!pending) {
    cleanup();
    return res.status(404).json({ error: 'Pedido de clipe desconhecido ou expirado.' });
  }
  if (files.length === 0) {
    cleanup();
    failClipRequest(requestId, 'Nenhum vídeo recebido.');
    return res.status(400).json({ error: 'Nenhum vídeo recebido.' });
  }

  try {
    const startOffsetMs = Math.max(0, Number(req.body.startOffsetMs) || 0);
    let durations = [];
    try { durations = JSON.parse(req.body.segmentDurationsMs || '[]'); } catch {}

    const id = crypto.randomBytes(8).toString('hex');
    const videoName = `${id}.mp4`;
    const posterName = `${id}.jpg`;
    await renderClip({
      files,
      durations,
      startOffsetMs,
      duration: pending.duration,
      output: path.join(CLIPS_DIR, videoName),
      poster: path.join(CLIPS_DIR, posterName),
    });

    const clip = {
      url: `/media/${videoName}`,
      posterUrl: `/media/${posterName}`,
      code: pending.code,
      duration: pending.duration,
      createdAt: new Date().toISOString(),
    };
    addClip(clip);

    clearTimeout(pending.timer);
    clipRequests.delete(requestId);
    send(pending.viewer, { type: 'clip-result', requestId, url: clip.url });
    res.json(clip);
  } catch (error) {
    console.error('Clip processing failed:', error);
    failClipRequest(requestId, 'Falha ao processar o clipe.');
    res.status(500).json({ error: 'Falha ao processar o clipe.' });
  } finally {
    cleanup();
  }
});

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) => {
      if (err) reject(new Error(stderr.split('\n').slice(-8).join('\n')));
      else resolve();
    });
  });
}

// Read resolution and whether there is an audio stream ("ffmpeg -i" prints it).
function probe(file) {
  return new Promise((resolve) => {
    execFile(ffmpegPath, ['-hide_banner', '-i', file], (_err, _out, stderr = '') => {
      const size = stderr.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
      resolve({
        width: size ? Number(size[1]) : 0,
        height: size ? Number(size[2]) : 0,
        hasAudio: /Stream #.*Audio:/.test(stderr),
      });
    });
  });
}

const even = (n) => Math.max(2, Math.floor(n / 2) * 2);

// Join the WebM segments (each a standalone MediaRecorder file), cut away the
// extra lead-in, and encode one MP4 + a poster frame. Segments may come from
// different sources (the broadcaster can switch mid-stream), so each one is
// normalized to the same size/fps and gets silent audio if it has none.
async function renderClip({ files, durations, startOffsetMs, duration, output, poster }) {
  const info = await Promise.all(files.map((f) => probe(f.path)));
  const first = info.find((i) => i.width && i.height) || { width: 1280, height: 720 };
  let W = first.width;
  let H = first.height;
  const fit = Math.min(1, 1920 / W, 1080 / H);
  W = even(W * fit);
  H = even(H * fit);

  const inputs = [];
  const filters = [];
  const pairs = [];
  files.forEach((f, i) => {
    inputs.push('-i', f.path);
    const d = Number(durations[i]) > 0 ? (Number(durations[i]) / 1000).toFixed(3) : '5';
    filters.push(
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p,` +
      `tpad=stop_mode=clone:stop_duration=1,trim=duration=${d},setpts=PTS-STARTPTS[v${i}]`,
    );
    filters.push(info[i].hasAudio
      ? `[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=duration=${d},asetpts=PTS-STARTPTS[a${i}]`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${d}[a${i}]`);
    pairs.push(`[v${i}][a${i}]`);
  });
  const start = (startOffsetMs / 1000).toFixed(3);
  filters.push(`${pairs.join('')}concat=n=${files.length}:v=1:a=1[vc][ac]`);
  filters.push(`[vc]trim=start=${start}:duration=${duration},setpts=PTS-STARTPTS[vo]`);
  filters.push(`[ac]atrim=start=${start}:duration=${duration},asetpts=PTS-STARTPTS[ao]`);

  await runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[vo]', '-map', '[ao]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    output,
  ]);
  await runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', output, '-frames:v', '1', '-vf', 'scale=640:-2', poster,
  ]);
}

// ---------- WebSocket signaling ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.role = null;     // 'broadcaster' | 'viewer'
  ws.code = null;
  ws.viewerId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const room = ws.code ? rooms.get(ws.code) : null;

    switch (msg.type) {
      case 'create-room': {
        if (ws.role) return;
        const code = newRoomCode();
        rooms.set(code, { broadcaster: ws, viewers: new Map() });
        ws.role = 'broadcaster';
        ws.code = code;
        send(ws, { type: 'room-created', code });
        console.log(`room ${code} created`);
        break;
      }

      case 'join-room': {
        if (ws.role) return;
        const code = String(msg.code || '').trim().toUpperCase();
        const target = rooms.get(code);
        if (!target) return send(ws, { type: 'error', message: 'Sala não encontrada. Confira o código.' });
        const viewerId = crypto.randomUUID();
        ws.role = 'viewer';
        ws.code = code;
        ws.viewerId = viewerId;
        target.viewers.set(viewerId, ws);
        send(ws, { type: 'joined', code });
        send(target.broadcaster, { type: 'viewer-joined', viewerId });
        break;
      }

      case 'offer': {
        if (ws.role !== 'broadcaster' || !room) return;
        send(room.viewers.get(msg.target), { type: 'offer', sdp: msg.sdp });
        break;
      }

      case 'answer': {
        if (ws.role !== 'viewer' || !room) return;
        send(room.broadcaster, { type: 'answer', from: ws.viewerId, sdp: msg.sdp });
        break;
      }

      case 'ice-candidate': {
        if (!room) return;
        if (ws.role === 'broadcaster') {
          send(room.viewers.get(msg.target), { type: 'ice-candidate', candidate: msg.candidate });
        } else {
          send(room.broadcaster, { type: 'ice-candidate', from: ws.viewerId, candidate: msg.candidate });
        }
        break;
      }

      case 'clip-request': {
        if (ws.role !== 'viewer' || !room) return;
        const duration = Math.min(MAX_CLIP_SECONDS, Math.max(5, Number(msg.duration) || 30));
        const requestId = crypto.randomUUID();
        const timer = setTimeout(
          () => failClipRequest(requestId, 'Tempo esgotado ao gerar o clipe.'),
          CLIP_REQUEST_TIMEOUT_MS,
        );
        clipRequests.set(requestId, { viewer: ws, code: ws.code, duration, timer });
        send(ws, { type: 'clip-accepted', requestId });
        send(room.broadcaster, { type: 'clip-request', requestId, duration });
        break;
      }

      case 'clip-upload-failed': {
        if (ws.role !== 'broadcaster') return;
        const req = clipRequests.get(msg.requestId);
        if (req && req.code === ws.code) {
          failClipRequest(msg.requestId, 'O transmissor não conseguiu gerar o clipe.');
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    const room = ws.code ? rooms.get(ws.code) : null;
    if (!room) return;

    if (ws.role === 'broadcaster' && room.broadcaster === ws) {
      for (const viewer of room.viewers.values()) send(viewer, { type: 'broadcast-ended' });
      for (const [id, req] of clipRequests) {
        if (req.code === ws.code) failClipRequest(id, 'A transmissão foi encerrada.');
      }
      rooms.delete(ws.code);
      console.log(`room ${ws.code} closed`);
    } else if (ws.role === 'viewer') {
      room.viewers.delete(ws.viewerId);
      send(room.broadcaster, { type: 'viewer-left', viewerId: ws.viewerId });
    }
  });
});

// Drop dead sockets (keeps hosts like Render from holding zombie rooms).
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

server.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
