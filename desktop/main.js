// Electron main process: the window, the screen/window list for the picker,
// and the bridge (IPC) the renderer uses for things a web page can't do.
//
//   audio-capture.js   per-app audio via native/appaudio.exe
//   preload.js         the `liveShare` API exposed to the renderer
//   renderer/          the UI (see renderer/js/state.js for an overview)
const { app, BrowserWindow, desktopCapturer, ipcMain, session, shell, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { AudioCapture, helperPathFor } = require('./audio-capture');

// Invisible system/overlay windows that desktopCapturer still reports.
const HIDDEN_WINDOWS = ['NVIDIA GeForce Overlay', 'Program Manager', 'Windows Input Experience', 'Microsoft Text Input Application'];

let win = null;
let audio = null;
let selectedSourceId = null;
const sourcesById = new Map(); // from the last listing, for getDisplayMedia

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------------------------------------------------------- screens and windows

async function listSources() {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });
  sourcesById.clear();
  for (const s of sources) sourcesById.set(s.id, s);
  return sources
    .filter((s) => !s.name.startsWith('Live Share') && !HIDDEN_WINDOWS.includes(s.name))
    .map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      hwnd: s.id.startsWith('window:') ? s.id.split(':')[1] : null, // "window:<hwnd>:0"
      thumbnail: s.thumbnail.toDataURL(),
      icon: s.appIcon ? s.appIcon.toDataURL() : null,
    }));
}

function isProcessAlive(pid) {
  try {
    process.kill(Number(pid), 0); // signal 0 = existence check
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists, just not ours
  }
}

// ---------------------------------------------------------------- IPC (see preload.js)

function registerIpc() {
  ipcMain.handle('sources:list', listSources);
  ipcMain.handle('sources:select', (_e, id) => { selectedSourceId = id; });
  ipcMain.handle('apps:list', () => audio.listApps());
  ipcMain.handle('audio:set-mode', (_e, mode) => audio.setMode(mode));
  ipcMain.handle('discord:status', async () => (await audio.findDiscord()).length > 0);
  ipcMain.handle('process:alive', (_e, pid) => isProcessAlive(pid));
  ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));
  ipcMain.handle('open:external', (_e, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
}

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
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: testOptions() });
  win.on('closed', () => { win = null; });
}

// Automated tests (desktop/test/e2e.js) drive the app through env variables.
function testOptions() {
  const query = {};
  if (process.env.LIVESHARE_AUTOTEST) {
    query.autotest = '1';
    if (process.env.LIVESHARE_AUDIO) query.audio = process.env.LIVESHARE_AUDIO;
    if (process.env.LIVESHARE_SERVER) query.server = process.env.LIVESHARE_SERVER;
  }
  return query;
}

function setupTestHooks() {
  if (process.env.LIVESHARE_AUTOTEST || process.env.LIVESHARE_CAPTURE_PAGE) {
    win.webContents.on('console-message', (_e, level, message) => console.log(`[renderer:${level}] ${message}`));
  }
  if (process.env.LIVESHARE_CAPTURE_PAGE) {
    // Save a screenshot of the UI, then quit.
    setTimeout(async () => {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(process.env.LIVESHARE_CAPTURE_PAGE, image.toPNG());
      app.quit();
    }, Number(process.env.LIVESHARE_CAPTURE_DELAY || 4000));
  }
}

// ---------------------------------------------------------------- startup

app.whenReady().then(() => {
  audio = new AudioCapture(helperPathFor(app), sendToRenderer);
  registerIpc();

  // The renderer's getDisplayMedia() gets the source picked in our own UI.
  // Audio comes from appaudio.exe, so the request never carries audio.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    const source = sourcesById.get(selectedSourceId);
    callback(source ? { video: source } : {});
  });
  // Allow microphone/device access for the "input device" audio option.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(['media', 'display-capture', 'clipboard-sanitized-write'].includes(permission));
  });

  createWindow();
  setupTestHooks();
});

app.on('window-all-closed', () => {
  audio?.dispose();
  app.quit();
});
app.on('before-quit', () => audio?.dispose());
