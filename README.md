# live-share

Browser screen sharing with room codes, plus "clip the last 30/60 seconds" for viewers.

- **Broadcast** (`/broadcast.html`): shares your screen (up to 1080p30, with audio) and gets a 4-character room code.
- **Watch** (`/watch.html`): join with the code (or `/watch.html?code=ABCD`). Video goes peer-to-peer over WebRTC; the server only relays signaling.
- **Clips**: while someone is watching, the broadcaster's browser keeps a rolling ~75s buffer of 5s WebM segments. When a viewer hits "Clipar", the server asks the broadcaster for the segments, then ffmpeg joins them, trims to exactly 30/60s, and saves an MP4 + poster. Browse them at `/clips.html`.

## Run

```bash
npm install
npm approve-scripts ffmpeg-static   # npm 11+: lets ffmpeg-static download its binary
npm start
```

Open http://localhost:3000. Screen capture needs HTTPS or localhost.

| Env var | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `DATA_DIR` | `./data` | clips, index, temp uploads |
| `FFMPEG_PATH` | bundled `ffmpeg-static` | use a system ffmpeg instead |

## Notes

- Only a public STUN server is configured. Viewers behind strict NATs need a TURN server added to `iceServers` in `broadcast.html` and `watch.html`.
- Clips are stored on local disk. On hosts with ephemeral disks (Render free tier, etc.) mount a persistent disk at `DATA_DIR` or swap the storage for S3/Cloudinary in `server.js`.
- Each viewer gets their own peer connection from the broadcaster, so upload bandwidth scales with viewer count (~8 Mbps cap each).
