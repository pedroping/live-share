// All tunables in one place. Values can be overridden with environment
// variables (Render sets PORT; tests set DATA_DIR and shorter timeouts).
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

module.exports = {
  PORT: Number(process.env.PORT) || 3000,
  PUBLIC_DIR: path.join(__dirname, '..', 'public'),

  // Where clips live. On Render's free plan this disk is wiped on restart.
  DATA_DIR,
  CLIPS_DIR: path.join(DATA_DIR, 'clips'),
  UPLOADS_DIR: path.join(DATA_DIR, 'tmp'),
  CLIP_INDEX_FILE: path.join(DATA_DIR, 'clips.json'),

  FFMPEG_PATH: process.env.FFMPEG_PATH || require('ffmpeg-static'),

  // A viewer waits at most this long for a clip before giving up.
  CLIP_REQUEST_TIMEOUT_MS: 240_000,
  MIN_CLIP_SECONDS: 5,
  MAX_CLIP_SECONDS: 60,

  // When the broadcaster's connection drops, the room stays open this long
  // so the app can reconnect and reclaim it. Viewers keep watching meanwhile
  // because the video itself is peer-to-peer.
  ROOM_GRACE_MS: Number(process.env.ROOM_GRACE_MS) || 45_000,

  // How often dead WebSocket connections are detected and dropped.
  HEARTBEAT_MS: 30_000,
};
