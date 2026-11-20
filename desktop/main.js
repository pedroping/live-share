const { app, BrowserWindow, desktopCapturer, ipcMain, session, shell, clipboard } = require('electron');
const { execFile, spawn } = require('child_process');
const path = require('path');

// Invisible system/overlay windows that desktopCapturer still reports.
const HIDDEN_WINDOWS = ['NVIDIA GeForce Overlay', 'Program Manager', 'Windows Input Experience', 'Microsoft Text Input Application'];
const DISCORD_NAMES =['discord.exe', 'discordptb.exe', 'discordcanary.exe', 'discorddevelopment.exe'];
const helperPath = app.isPackaged
  ? path.join(process.resourcesPath, 'appaudio.exe')
  : path.join(__dirname, 'native', 'appaudio.exe');

let win;
let selectedSourceId = null;
const sourceCache = new Map(); // id -> DesktopCapturerSource

// ---------------------------------------------------------------- helper calls
function helperJson(command) {
  return new Promise((resolve) => {
    execFile(helperPath, [command], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      try { resolve(JSON.parse(stdout)); } catch { resolve([]); }
    });
  });
}

async function findDiscordRoots() {
  const processes = await helperJson('processes');
  return processes.filter((p) => DISCORD_NAMES.includes(p.name.toLowerCase()));
}

// ---------------------------------------------------------------- audio capture
// Modes:
//   { type: 'except-discord' }   all system audio except every Discord process tree
//   { type: 'system' }           all system audio (except this app, which plays nothing)
//   { type: 'include', pid }     only that app's process tree
//   { type: 'exclude', pid }     everything except that app's process tree
//   { type: 'window', hwnd }     only the app that owns the shared window
const audio = {
  mode: null,
  proc: null,
  targetKey: null,
  leftover: Buffer.alloc(0),
  watchTimer: null,
};

function stopHelper() {
  if (audio.proc) {
    audio.proc.removeAllListeners();
    audio.proc.stdout.removeAllListeners();
    try { audio.proc.stdin.end(); } catch {}
    audio.proc.kill();
  }
  audio.proc = null;
  audio.targetKey = null;
  audio.leftover = Buffer.alloc(0);
}

function startHelper(mode, pid, description) {
  const key = `${mode}:${pid}`;
  if (audio.proc && audio.targetKey === key) return;
  stopHelper();
  const proc = spawn(helperPath, ['capture', mode, String(pid)], { windowsHide: true });
  audio.proc = proc;
  audio.targetKey = key;

  proc.stdout.on('data', (chunk) => {
    // Forward whole 4-byte frames (16-bit stereo) only.
    let data = audio.leftover.length ? Buffer.concat([audio.leftover, chunk]) : chunk;
    const usable = data.length - (data.length % 4);
    audio.leftover = data.subarray(usable);
    if (usable > 0 && win && !win.isDestroyed()) {
      win.webContents.send('audio:data', new Uint8Array(data.buffer, data.byteOffset, usable).slice());
    }
  });
  proc.stderr.on('data', (d) => {
    const text = d.toString().trim();
    if (text.startsWith('error')) send('audio:status', { ok: false, text });
  });
  proc.on('exit', (code) => {
    if (audio.proc !== proc) return;
    audio.proc = null;
    audio.targetKey = null;
    if (code) send('audio:status', { ok: false, text: 'A captura de áudio parou (código ' + code + '). Windows 10 2004+ é necessário.' });
  });
  send('audio:status', { ok: true, text: description });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

async function applyAudioMode() {
  const mode = audio.mode;
  if (!mode || mode.type === 'off') { stopHelper(); return; }

  if (mode.type === 'except-discord') {
    const roots = await findDiscordRoots();
    if (roots.length === 0) {
      startHelper('exclude', process.pid, 'Todo o áudio do sistema (Discord não está aberto)');
    } else {
      // Process loopback can exclude one tree; the main Discord process owns the
      // voice/notification children, so exclude the oldest (lowest pid) root.
      const target = roots.sort((a, b) => a.pid - b.pid)[0];
      startHelper('exclude', target.pid, `Todo o áudio do sistema, exceto ${target.name}`);
    }
  } else if (mode.type === 'system') {
    startHelper('exclude', process.pid, 'Todo o áudio do sistema');
  } else if (mode.type === 'include') {
    startHelper('include', mode.pid, `Só o áudio de ${mode.name || 'pid ' + mode.pid}`);
  } else if (mode.type === 'exclude') {
    startHelper('exclude', mode.pid, `Todo o áudio, exceto ${mode.name || 'pid ' + mode.pid}`);
  } else if (mode.type === 'window') {
    const windows = await helperJson('windows');
    const owner = windows.find((w) => String(w.hwnd) === String(mode.hwnd));
    if (owner) startHelper('include', owner.rootPid, `Só o áudio de ${owner.name}`);
    else send('audio:status', { ok: false, text: 'Não encontrei o app dessa janela.' });
  }
}

ipcMain.handle('audio:set-mode', async (_e, mode) => {
  audio.mode = mode;
  await applyAudioMode();
});

// Discord may be opened, closed or restarted mid-stream: re-check periodically.
function startAudioWatch() {
  clearInterval(audio.watchTimer);
  audio.watchTimer = setInterval(() => {
    if (audio.mode && ['except-discord', 'window'].includes(audio.mode.type)) applyAudioMode();
    else if (audio.mode && audio.mode.type !== 'off' && !audio.proc) applyAudioMode();
  }, 5000);
}

// ---------------------------------------------------------------- sources
ipcMain.handle('sources:list', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });
  sourceCache.clear();
  for (const s of sources) sourceCache.set(s.id, s);
  return sources
    .filter((s) => !s.name.startsWith('Live Share') && !HIDDEN_WINDOWS.includes(s.name))
    .map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      hwnd: s.id.startsWith('window:') ? s.id.split(':')[1] : null,
      thumbnail: s.thumbnail.toDataURL(),
      icon: s.appIcon ? s.appIcon.toDataURL() : null,
    }));
});

ipcMain.handle('sources:select', (_e, id) => { selectedSourceId = id; });

ipcMain.handle('apps:list', async () => {
  const processes = await helperJson('processes');
  const hidden = new Set(['explorer.exe', 'svchost.exe', 'textinputhost.exe', 'applicationframehost.exe', 'systemsettings.exe']);
  const seen = new Set();
  return processes
    .filter((p) => (p.hasWindow || DISCORD_NAMES.includes(p.name.toLowerCase())) && !hidden.has(p.name.toLowerCase()))
    .filter((p) => p.pid !== process.pid)
    .filter((p) => { const k = p.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.name.localeCompare(b.name));
});

ipcMain.handle('discord:status', async () => (await findDiscordRoots()).length > 0);
ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));
ipcMain.handle('open:external', (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

// ---------------------------------------------------------------- window
function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 760,
    minHeight: 600,
    backgroundColor: '#1e1f22',
    title: 'Live Share',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep streaming while minimized
    },
  });
  const query = {};
  if (process.env.LIVESHARE_AUTOTEST) {
    query.autotest = '1';
    if (process.env.LIVESHARE_AUDIO) query.audio = process.env.LIVESHARE_AUDIO;
    if (process.env.LIVESHARE_SERVER) query.server = process.env.LIVESHARE_SERVER;
  }
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query });
  if (process.env.LIVESHARE_AUTOTEST || process.env.LIVESHARE_CAPTURE_PAGE) {
    win.webContents.on('console-message', (_e, level, message) => console.log(`[renderer:${level}] ${message}`));
  }
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  // getDisplayMedia() in the renderer gets the source picked in our own UI.
  // Audio comes from appaudio.exe, so the video request never carries audio.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    const source = sourceCache.get(selectedSourceId);
    if (!source) return callback({});
    callback({ video: source });
  });
  // Allow mic/device access for the "input device" audio option.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'clipboard-sanitized-write'].includes(permission));
  });

  createWindow();
  startAudioWatch();

  if (process.env.LIVESHARE_CAPTURE_PAGE) {
    // Test hook: save a screenshot of the UI, then quit.
    setTimeout(async () => {
      const image = await win.webContents.capturePage();
      require('fs').writeFileSync(process.env.LIVESHARE_CAPTURE_PAGE, image.toPNG());
      app.quit();
    }, Number(process.env.LIVESHARE_CAPTURE_DELAY || 4000));
  }
});

app.on('window-all-closed', () => {
  stopHelper();
  app.quit();
});
app.on('before-quit', stopHelper);
