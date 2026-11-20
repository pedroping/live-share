// Shared state and settings for the desktop renderer. Loaded first.
//
// Files (classic scripts sharing these globals, loaded in this order):
//   state.js          this file: settings, quality presets, app state
//   server-status.js  wakes the (free, sleepy) server and shows its status
//   source-picker.js  the grid of screens/windows with live thumbnails
//   audio.js          audio source choice; per-app audio via appaudio.exe
//   live.js           going live, switching source, stopping
//   main.js           startup (and the automated-test hook)
const $ = (id) => document.getElementById(id);

const DEFAULT_SERVER = 'https://live-share-wexj.onrender.com';
const params = new URLSearchParams(location.search); // test hooks pass options here

const QUALITY = {
  '720p30': { width: 1280, height: 720, frameRate: 30, bitrate: 4_000_000 },
  '1080p30': { width: 1920, height: 1080, frameRate: 30, bitrate: 8_000_000 },
  '1080p60': { width: 1920, height: 1080, frameRate: 60, bitrate: 12_000_000 },
  '1440p60': { width: 2560, height: 1440, frameRate: 60, bitrate: 16_000_000 },
};

const state = {
  selected: null,        // picked source: { id, name, kind: 'screen'|'window', hwnd }
  displayStream: null,   // screen/window video
  deviceStream: null,    // input device audio, when one is chosen
  liveStream: null,      // what is sent: video + chosen audio
  live: false,
  session: null,         // BroadcastSession while live
  audioValue: 'except-discord', // see audio.js for the possible values
};

// Settings remembered between runs.
const store = {
  get(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } },
};

function serverUrl() {
  return $('serverUrl').value.trim().replace(/\/+$/, '') || DEFAULT_SERVER;
}

function currentQuality() {
  return QUALITY[$('qualitySelect').value];
}
