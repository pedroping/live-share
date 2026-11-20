// Live Share server: serves the website and clips over HTTP, and relays
// WebRTC signaling over WebSocket on the same port.
//
//   server/http.js           website, /healthz, clips API
//   server/signaling.js      rooms and broadcaster <-> viewer messages
//   server/clip-renderer.js  joins uploaded segments into a clip (ffmpeg)
//   server/config.js         ports, folders and timeouts
const fs = require('fs');
const http = require('http');
const { PORT, DATA_DIR, CLIPS_DIR, UPLOADS_DIR } = require('./server/config');
const { createHttpApp } = require('./server/http');
const { attachSignaling } = require('./server/signaling');

for (const dir of [DATA_DIR, CLIPS_DIR, UPLOADS_DIR]) fs.mkdirSync(dir, { recursive: true });

const server = http.createServer(createHttpApp());
attachSignaling(server);
server.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
