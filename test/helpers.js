// Shared helpers for the server tests: start a throwaway server, talk to it
// over WebSocket like the real pages do, and make small test video segments.
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const WebSocket = require('ws');
const ffmpegPath = require('ffmpeg-static');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Starts server.js on a free port with its own data folder.
async function startServer({ dataDir, env = {} } = {}) {
  const port = await freePort();
  dataDir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'live-share-test-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start:\n' + logs.join(''))), 10_000);
    child.stdout.on('data', (d) => { if (/Listening/.test(d)) { clearTimeout(timer); resolve(); } });
    child.on('exit', (code) => reject(new Error(`server exited ${code}:\n${logs.join('')}`)));
  });
  const base = `http://localhost:${port}`;
  return {
    base,
    wsUrl: `ws://localhost:${port}`,
    port,
    dataDir,
    logs,
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill();
    }),
  };
}

// A WebSocket client that queues every message so tests can await by type.
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return {
    ws,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next(type, timeoutMs = 5000) {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { type, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const j = waiters.indexOf(waiter);
          if (j >= 0) { waiters.splice(j, 1); reject(new Error(`no "${type}" message within ${timeoutMs}ms`)); }
        }, timeoutMs);
      });
    },
    // Resolves true if no message of this type arrives within the window.
    async none(type, windowMs = 500) {
      try { await this.next(type, windowMs); return false; } catch { return true; }
    },
    close: () => new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.once('close', resolve);
      ws.close();
    }),
  };
}

// Makes a 5-second WebM like the ones MediaRecorder uploads.
function makeSegment(file, { width = 640, height = 360, audio = true, pattern = 'testsrc' } = {}) {
  if (fs.existsSync(file)) return file;
  const args = ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `${pattern}=size=${width}x${height}:rate=30`];
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440');
  args.push('-t', '5', '-c:v', 'libvpx', '-b:v', '800k');
  if (audio) args.push('-c:a', 'libopus');
  args.push(file);
  execFileSync(ffmpegPath, args);
  return file;
}

// Duration and stream summary of a media file.
function mediaInfo(file) {
  let stderr = '';
  try { execFileSync(ffmpegPath, ['-hide_banner', '-i', file], { stdio: 'pipe' }); } catch (e) { stderr = e.stderr.toString(); }
  const d = stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
  return {
    seconds: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
    video: (stderr.match(/Video: (\w+)/) || [])[1] || null,
    audio: (stderr.match(/Audio: (\w+)/) || [])[1] || null,
    size: (stderr.match(/Video: .*?(\d{2,5}x\d{2,5})/) || [])[1] || null,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { ROOT, startServer, connect, makeSegment, mediaInfo, sleep, freePort };
