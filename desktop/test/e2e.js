// End-to-end test with real browsers (Electron windows) and a real server.
//
//   npm run test:e2e            (from desktop/)
//
// 1. Desktop app broadcasts -> a viewer watches -> the server is killed and
//    restarted mid-stream -> the viewer keeps playing, the room keeps its
//    code -> a clip is saved.
// 2. The web broadcast page streams to a viewer -> a clip is saved.
//
// Windows are hidden; the screen is captured, so something will be streamed
// but nothing is shown. Exits with code 0 on success, 1 on failure.
const { app, BrowserWindow, desktopCapturer, session } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DESKTOP = path.join(__dirname, '..');
const PORT = 3977;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'live-share-e2e-'));

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Windows open and close between scenarios; don't quit when none are left.
app.on('window-all-closed', () => {});

const t0 = Date.now();
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
function check(ok, what) {
  log(ok ? '  ✔' : '  ✖', what);
  if (!ok) failures.push(what);
}

// ---------------------------------------------------------------- processes
let server;
function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.env.NODE_BINARY || 'node', ['server.js'], {
      cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR }, shell: process.platform === 'win32',
    });
    server.stdout.on('data', (d) => { if (/Listening/.test(d)) resolve(); });
    server.on('error', reject);
  });
}
function stopServer() {
  return new Promise((resolve) => {
    if (!server || server.exitCode !== null) return resolve();
    server.once('exit', resolve);
    if (process.platform === 'win32') spawn('taskkill', ['/F', '/T', '/PID', String(server.pid)]);
    else server.kill();
  });
}

function startDesktopApp() {
  const proc = spawn(process.execPath, [DESKTOP], {
    env: { ...process.env, LIVESHARE_AUTOTEST: '1', LIVESHARE_AUDIO: 'except-discord', LIVESHARE_SERVER: BASE },
  });
  const room = new Promise((resolve) => {
    proc.stdout.on('data', (d) => {
      const m = d.toString().match(/LIVESHARE_ROOM (\w+)/);
      if (m) resolve(m[1]);
    });
  });
  return { proc, room };
}

// ---------------------------------------------------------------- viewer
async function openViewer(code) {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('dom-ready', () => win.webContents.executeJavaScript('window.alert = (m) => console.log("ALERT " + m); 0'));
  await win.loadURL(`${BASE}/watch.html?code=${code}`);
  return win;
}

function viewerState(win) {
  return win.webContents.executeJavaScript(`(() => {
    const v = document.getElementById('remoteVideo');
    return {
      time: v.currentTime,
      width: v.videoWidth,
      audioTracks: v.srcObject ? v.srcObject.getAudioTracks().length : 0,
      connection: typeof pc !== 'undefined' && pc ? pc.connectionState : 'none',
      clip: document.getElementById('clipStatus').innerText,
    };
  })()`);
}

async function waitFor(fn, what, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(500);
  }
  throw new Error('timed out waiting for ' + what);
}

async function requestClip(viewer) {
  await viewer.webContents.executeJavaScript('makeClip(30)');
  const status = await waitFor(async () => {
    const s = (await viewerState(viewer)).clip;
    return /salvo|Erro/.test(s) && s;
  }, 'clip result', 90_000);
  return status;
}

// ---------------------------------------------------------------- scenarios
async function desktopScenario() {
  log('Scenario 1: desktop app -> viewer, server restart, clip');
  const desktop = startDesktopApp();
  try {
    const code = await Promise.race([desktop.room, sleep(30_000).then(() => null)]);
    check(!!code, `desktop app went live (room ${code})`);
    if (!code) return;

    const viewer = await openViewer(code);
    const live = await waitFor(async () => {
      const s = await viewerState(viewer);
      return s.width > 0 && s.time > 1 && s;
    }, 'viewer video');
    check(live.connection === 'connected', 'viewer connected peer-to-peer');
    check(live.width > 0, `viewer receives video (${live.width}px wide)`);
    check(live.audioTracks === 1, 'viewer receives an audio track');

    log('  killing the server for 6s…');
    await stopServer();
    const before = (await viewerState(viewer)).time;
    await sleep(6000);
    const during = (await viewerState(viewer)).time;
    check(during - before > 4, `video kept playing while the server was down (+${(during - before).toFixed(1)}s)`);

    await startServer();
    await sleep(6000); // reconnect + viewer resume
    const res = await fetch(`${BASE}/healthz`);
    check(res.ok, 'server back up');

    const status = await requestClip(viewer);
    check(/salvo/.test(status), `clip after restart: ${status.replace(/\s+/g, ' ')}`);

    const after = await viewerState(viewer);
    check(after.time > during + 5, 'viewer still playing at the end');
    viewer.destroy();
  } finally {
    desktop.proc.kill();
  }
}

async function webScenario() {
  log('Scenario 2: web broadcast page -> viewer, clip');
  // Answer the page's getDisplayMedia() with the first screen (no picker).
  const ses = session.fromPartition('web-broadcaster');
  ses.setDisplayMediaRequestHandler(async (_req, callback) => {
    const [screen] = await desktopCapturer.getSources({ types: ['screen'] });
    callback({ video: screen });
  });
  const broadcaster = new BrowserWindow({ show: false, webPreferences: { session: ses, backgroundThrottling: false } });
  broadcaster.webContents.on('dom-ready', () => broadcaster.webContents.executeJavaScript('window.alert = (m) => console.log("ALERT " + m); 0'));
  await broadcaster.loadURL(`${BASE}/broadcast.html`);
  await broadcaster.webContents.executeJavaScript(`document.getElementById('startBtn').click()`, true);
  const code = await waitFor(() => broadcaster.webContents.executeJavaScript(
    `(document.getElementById('codeDisplay').textContent || '').trim()`), 'room code');
  check(/^[A-Z2-9]{4}$/.test(code), `web broadcaster went live (room ${code})`);

  const viewer = await openViewer(code);
  const live = await waitFor(async () => {
    const s = await viewerState(viewer);
    return s.width > 0 && s.time > 1 && s;
  }, 'viewer video');
  check(live.width > 0, `viewer receives video from the web page (${live.width}px wide)`);

  const link = await broadcaster.webContents.executeJavaScript(`document.getElementById('watchLink').textContent`);
  check(link === `${BASE}/watch.html?code=${code}`, 'share link points to the watch page');

  await sleep(6000); // let the clip buffer fill at least one segment
  const status = await requestClip(viewer);
  check(/salvo/.test(status), `clip from web broadcast: ${status.replace(/\s+/g, ' ')}`);

  await broadcaster.webContents.executeJavaScript(`document.getElementById('stopBtn') && document.getElementById('stopBtn').click()`);
  viewer.destroy();
  broadcaster.destroy();
}

app.whenReady().then(async () => {
  try {
    await startServer();
    if (!process.env.E2E_ONLY || process.env.E2E_ONLY === 'desktop') await desktopScenario();
    if (!process.env.E2E_ONLY || process.env.E2E_ONLY === 'web') await webScenario();
  } catch (error) {
    failures.push(error.message);
    log('  ✖', error.message);
  } finally {
    await stopServer();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    log(failures.length ? `FAILED (${failures.length})` : 'ALL PASSED');
    app.exit(failures.length ? 1 : 0);
  }
});
