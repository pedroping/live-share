// Per-app audio isolation (Windows only). Plays a quiet 440 Hz tone from one
// process for a few seconds and checks that:
//   "include <that process>" captures the tone, and
//   "exclude <that process>" (how Discord is left out) does not.
//
//   npm test   (from desktop/)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HELPER = path.join(__dirname, '..', 'native', 'appaudio.exe');
const ffmpegPath = require(path.join(__dirname, '..', '..', 'node_modules', 'ffmpeg-static'));
const windowsOnly = { skip: process.platform !== 'win32' && 'Windows only' };

// Strength of the 440 Hz component (Goertzel) in 16-bit stereo PCM.
function toneStrength(pcm) {
  const frames = Math.floor(pcm.length / 4);
  const k = 2 * Math.cos((2 * Math.PI * 440) / 48000);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < frames; i++) {
    const s = pcm.readInt16LE(i * 4) / 32768 + k * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - k * s1 * s2) / Math.max(1, frames);
}

function capture(mode, pid, ms = 1500) {
  return new Promise((resolve) => {
    const proc = spawn(HELPER, ['capture', mode, String(pid)]);
    const chunks = [];
    proc.stdout.on('data', (d) => chunks.push(d));
    setTimeout(() => { proc.kill(); resolve(Buffer.concat(chunks)); }, ms);
  });
}

test('lists processes and windows as JSON', windowsOnly, () => {
  const processes = JSON.parse(execFileSync(HELPER, ['processes']).toString());
  assert.ok(processes.length > 0 && processes.every((p) => typeof p.pid === 'number' && p.name));
  const windows = JSON.parse(execFileSync(HELPER, ['windows']).toString());
  assert.ok(Array.isArray(windows));
});

test('captures only the chosen app, or everything except it', windowsOnly, async () => {
  const wav = path.join(os.tmpdir(), 'live-share-tone.wav');
  if (!fs.existsSync(wav)) {
    execFileSync(ffmpegPath, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6,volume=0.05', '-ac', '2', '-ar', '48000', wav]);
  }
  const player = spawn('powershell', ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${wav}').PlaySync()`]);
  try {
    await new Promise((r) => setTimeout(r, 1500)); // let playback start
    const [only, except] = await Promise.all([capture('include', player.pid), capture('exclude', player.pid)]);
    assert.ok(only.length > 0 && except.length > 0, 'both captures produced audio data');
    const inTone = toneStrength(only);
    const outTone = toneStrength(except);
    assert.ok(inTone > 0.0005, `"only this app" should contain the tone (strength ${inTone.toFixed(5)})`);
    assert.ok(outTone < inTone / 10, `"everything except this app" should not (strength ${outTone.toFixed(5)})`);
  } finally {
    player.kill();
  }
});
