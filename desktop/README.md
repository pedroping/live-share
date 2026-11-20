# Live Share — desktop broadcaster

A Discord-style screen-share app for Windows that streams to the live-share website. Viewers just open the link in a browser.

## Download

- [LiveShare-Setup.exe](https://github.com/pedroping/live-share/releases/latest/download/LiveShare-Setup.exe): installer
- [LiveShare-Portable.exe](https://github.com/pedroping/live-share/releases/latest/download/LiveShare-Portable.exe): runs without installing

The builds are unsigned, so Windows SmartScreen will warn on first run: choose *More info → Run anyway*.

## What it adds over the web broadcaster

- **Discord-style picker**: a grid of your windows and screens with live thumbnails.
- **Per-app audio** using Windows' process-loopback API (the OS feature Discord uses):
  - **All system audio except Discord** (default): your call and Discord sounds stay out of the stream, and everything else goes through. It follows Discord if it's opened, closed or restarted mid-stream.
  - **Only the audio of the shared window's app.**
  - **Only the audio of a specific app**, or **everything except a specific app**.
  - Any input device (mic, VB-Cable…), or no audio.
- **Quality presets**: 720p30, 1080p30, 1080p60, 1440p60.
- Switch the video source or the audio source while live, without changing the room code.
- Copy or open the watch link; viewers can clip the last 30/60s as on the website.

Requires Windows 10 version 2004 or later (or Windows 11) for per-app audio.

## Run from source

```bash
cd desktop
npm install
npm approve-scripts electron   # npm 11+: lets Electron download its binary
npm start
```

`npm start` copies the shared clip recorder from `../public` and compiles `native/AppAudio.cs` into `appaudio.exe`. It uses the C# compiler that ships with Windows (.NET Framework 4.x), so there is nothing extra to install.

## Build the installer

```bash
cd desktop
npm run dist
```

This writes `dist/Live Share Setup <version>.exe` (installer) and `dist/Live Share <version>.exe` (portable). The builds are unsigned, so Windows SmartScreen will warn on first run: choose *More info → Run anyway*.

If NSIS fails with `!include: could not open file`, the project path is too long (over 260 characters). Build from a shorter folder.

## How the audio works

`native/appaudio.exe capture exclude <pid>` opens a WASAPI process-loopback stream for everything except that process tree, and writes 48 kHz stereo 16-bit PCM to stdout. The Electron main process forwards the PCM to the renderer, where an AudioWorklet turns it into a `MediaStreamTrack` that is sent over WebRTC next to the screen video. Excluding the root `Discord.exe` also excludes all of its child processes, including the one that plays voice.

The server URL defaults to `https://live-share-wexj.onrender.com`. Change it in the top bar.
