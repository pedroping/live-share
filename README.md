# live-share

Screen sharing with room codes, plus "clip the last 30/60 seconds" for viewers.

- **Broadcast** (`/broadcast.html`, or the [desktop app](#desktop-app-windows)): share your screen with audio and get a 4-character room code and a link.
- **Watch** (`/watch.html?code=ABCD`): open the link in any browser. Video goes peer-to-peer over WebRTC; the server only helps the two sides connect.
- **Clips**: while someone watches, the broadcaster keeps the last ~75 s in 5-second pieces. When a viewer clicks "Clipar", the broadcaster uploads them and the server joins them into a clip. Browse them at `/clips.html`.

Live at https://live-share-wexj.onrender.com.

## How it works

```
 Broadcaster (web page or desktop app)                      Viewer (web page)
 ┌──────────────────────────┐   1. room code, offer/answer   ┌──────────────────┐
 │ BroadcastSession         │◄──────── WebSocket ───────────►│ watch-page.js    │
 │  • one RTCPeerConnection │          (server)              │                  │
 │    per viewer            │                                │                  │
 │  • rolling clip recorder │═══ 2. video + audio, P2P ═════►│ <video>          │
 └────────────┬─────────────┘                                └────────┬─────────┘
              │ 3. clip segments (HTTP POST)                          │ clip request
              ▼                                                       ▼
        server: joins segments with ffmpeg ──► /media/<id>.webm ──► viewer gets the link
```

- The server never carries the video. If it restarts mid-stream, viewers keep watching; the broadcaster reconnects and gets the **same room code** back.
- Render's free plan sleeps after ~15 min idle. Pages wake it and say so ("acordando…"), and a live stream keeps it awake.

## Project layout

```
server.js                  entry point: HTTP + WebSocket on one port
server/
  config.js                ports, folders, timeouts (env overrides)
  signaling.js             rooms; relays messages between broadcaster and viewers (protocol documented at the top)
  http.js                  website, /healthz, clips API
  clip-requests.js         clip requests in flight (viewer asks → broadcaster uploads)
  clip-renderer.js         joins uploaded segments: stream copy / audio rebuild / re-encode
  clip-store.js            list of saved clips (clips.json)
public/
  index.html broadcast.html watch.html clips.html
  css/site.css             styles for all pages
  js/
    broadcast-session.js   the broadcaster's core (rooms, peers, reconnects, clips), shared with desktop/
    broadcast-page.js      web broadcaster UI: screen capture, audio source picker
    watch-page.js          viewer
    clip-recorder.js       rolling buffer of 5 s WebM segments (MediaRecorder)
    clip-buffer.js         picks which segments make up a clip
    server-wake.js         wakes the sleeping server, keeps it awake
    clip-gallery.js        clip grids on the home and gallery pages
desktop/                   Windows app (Electron), see desktop/README.md
test/                      server and unit tests
```

## Run locally

```bash
npm install
npm approve-scripts ffmpeg-static   # npm 11+: lets ffmpeg-static download its binary
npm start
```

Open http://localhost:3000. Screen capture needs HTTPS or localhost.

| Env var | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `DATA_DIR` | `./data` | clips, clip index, temporary uploads |
| `FFMPEG_PATH` | bundled `ffmpeg-static` | use a system ffmpeg instead |
| `ROOM_GRACE_MS` | `45000` | how long a room waits for a disconnected broadcaster |

## Tests

```bash
npm test                       # server: signaling, reconnects, all clip paths, wake helper
cd desktop && npm test         # per-app audio isolation (Windows; plays a quiet tone)
cd desktop && npm run test:e2e # real browsers: desktop app and web page broadcasting to a viewer,
                               # server killed mid-stream, clips
```

The end-to-end test captures your screen (in hidden windows) and needs the desktop dependencies installed.

## Deploy on Render

1. In Render, click **New → Blueprint** and pick this repo. It reads `render.yaml`.
   (Or **New → Web Service** with build `npm ci` and start `npm start`.)
2. Open `https://<your-service>.onrender.com/`.

Every push to `main` redeploys. Render provides HTTPS, which screen capture requires, and passes WebSockets through on the same port.

## Notes

- Only a public STUN server is configured. Viewers behind strict NATs (some mobile networks) may need a TURN server added to `ICE_SERVERS` in `public/js/broadcast-session.js` and `public/js/watch-page.js`.
- Clips are stored on local disk. On Render's free plan that disk is wiped on restart; mount a persistent disk at `DATA_DIR` or store clips elsewhere (`server/clip-store.js`, `server/http.js`).
- Each viewer gets their own connection from the broadcaster, so upload bandwidth grows with the number of viewers (~8 Mbps each at 1080p30).

## Desktop app (Windows)

`desktop/` is an Electron broadcaster with a Discord-style source picker and **per-app audio**, so it can stream all your PC audio *except Discord*. See [desktop/README.md](desktop/README.md).

**Download:** [Installer](https://github.com/pedroping/live-share/releases/latest/download/LiveShare-Setup.exe) · [Portable](https://github.com/pedroping/live-share/releases/latest/download/LiveShare-Portable.exe) · [All releases](https://github.com/pedroping/live-share/releases)
