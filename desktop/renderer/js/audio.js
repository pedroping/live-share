// Audio source for the stream.
//
// state.audioValue is one of:
//   'except-discord'           all PC audio except Discord (the default)
//   'system'                   all PC audio
//   'window'                   only the app that owns the shared window
//   'include:<pid>:<name>'     only that app
//   'exclude:<pid>:<name>'     everything except that app
//   'device:<deviceId>'        a microphone / virtual cable
//   'off'                      no audio
//
// The first five come from appaudio.exe (per-app capture, run by the main
// process): it sends raw PCM over IPC, and an AudioWorklet turns it into a
// normal audio track ("helperTrack") that can be sent over WebRTC.
const DEFAULT_AUDIO = 'except-discord';

let audioContext = null;
let pcmPlayer = null;    // AudioWorkletNode fed with PCM from appaudio.exe
let helperTrack = null;  // MediaStreamTrack produced by pcmPlayer
let analyser = null;     // drives the level meter
let meterSource = null;
let audioApplied = false;

// ---------------------------------------------------------------- per-app audio track

async function ensureHelperTrack() {
  if (helperTrack) return helperTrack;
  audioContext = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  // file:// pages can't addModule() a file, so load the worklet from a Blob.
  const blob = new Blob([`(${pcmWorkletModule.toString()})()`], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  await audioContext.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  pcmPlayer = new AudioWorkletNode(audioContext, 'pcm-player', { numberOfInputs: 0, outputChannelCount: [2] });
  const destination = audioContext.createMediaStreamDestination();
  pcmPlayer.connect(destination);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  pcmPlayer.connect(analyser);
  helperTrack = destination.stream.getAudioTracks()[0];

  liveShare.onAudioData((data) => {
    const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    pcmPlayer.port.postMessage(copy, [copy]);
  });
  if (audioContext.state === 'suspended') await audioContext.resume();
  return helperTrack;
}

// What appaudio.exe should capture for a given choice (null = not a helper mode).
function helperModeFor(value) {
  if (value === 'except-discord') return { type: 'except-discord' };
  if (value === 'system') return { type: 'system' };
  if (value === 'window') return { type: 'window', hwnd: state.selected?.hwnd };
  const [kind, pid, ...name] = value.split(':');
  if (kind === 'include' || kind === 'exclude') return { type: kind, pid: Number(pid), name: name.join(':') };
  return null;
}

function currentAudioTrack() {
  if (helperModeFor(state.audioValue)) return helperTrack;
  return state.deviceStream?.getAudioTracks()[0] || null;
}

function setAudioNote(text, kind = '') {
  $('audioNote').textContent = text;
  $('audioNote').className = 'note ' + kind;
}

// Start capturing for state.audioValue and, if live, send it to viewers.
async function applyAudio() {
  audioApplied = true;
  const value = state.audioValue;
  const helperMode = helperModeFor(value);
  const previousDevice = state.deviceStream;
  state.deviceStream = null;

  if (helperMode) {
    await ensureHelperTrack();
    pcmPlayer.port.postMessage('reset'); // drop buffered audio from the old source
    await liveShare.setAudioMode(helperMode);
  } else {
    await liveShare.setAudioMode({ type: 'off' });
    if (value.startsWith('device:')) {
      try {
        state.deviceStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: value.slice('device:'.length) },
            echoCancellation: false, noiseSuppression: false, autoGainControl: false,
            channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 },
          },
        });
        setAudioNote('Enviando: ' + state.deviceStream.getAudioTracks()[0].label, 'ok');
      } catch (e) {
        setAudioNote('Não foi possível abrir o dispositivo: ' + e.message, 'warn');
      }
    } else {
      setAudioNote('A transmissão vai sem áudio.');
    }
  }

  if (state.live) await updateLiveStream();
  if (previousDevice && previousDevice !== state.deviceStream) previousDevice.getTracks().forEach((t) => t.stop());
}

// ---------------------------------------------------------------- the dropdown

function optionGroup(label, options) {
  const group = document.createElement('optgroup');
  group.label = label;
  for (const [value, text] of options) group.appendChild(new Option(text, value));
  return group;
}

async function refreshAudioOptions() {
  const [apps, discordRunning] = await Promise.all([liveShare.listApps(), liveShare.isDiscordRunning()]);
  let devices = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.label);
  } catch { /* no device access */ }

  const sharedWindow = state.selected?.kind === 'window'
    ? [['window', `🪟 Só o áudio de "${state.selected.name.slice(0, 40)}"`]]
    : [];
  const groups = [
    ['Recomendado', [
      ['except-discord', '🔊 Todo o áudio do sistema, exceto Discord'],
      ...sharedWindow,
      ['system', 'Todo o áudio do sistema (inclui Discord)'],
      ['off', '🔇 Sem áudio'],
    ]],
    ['Só o áudio de um app', apps.map((a) => [`include:${a.pid}:${a.name}`, a.name])],
    ['Todo o áudio, exceto um app', apps.map((a) => [`exclude:${a.pid}:${a.name}`, `Tudo exceto ${a.name}`])],
    ['Dispositivo de entrada (microfone, VB-Cable…)', devices.map((d) => [`device:${d.deviceId}`, d.label])],
  ];

  const select = $('audioSelect');
  select.innerHTML = '';
  for (const [label, options] of groups) {
    if (options.length) select.appendChild(optionGroup(label, options));
  }
  await keepBackgroundAppSelected(select);

  // The chosen app or device went away: fall back to the Discord-safe default.
  const stillThere = [...select.options].some((o) => o.value === state.audioValue);
  if (!stillThere) state.audioValue = DEFAULT_AUDIO;
  select.value = state.audioValue;
  $('discordBadge').hidden = !(discordRunning && state.audioValue === 'except-discord');
  if (!stillThere && audioApplied) await applyAudio();
}

// An app minimized to the tray (e.g. Spotify) has no visible window, so it
// drops out of the app list while still playing. Keep it while it runs.
async function keepBackgroundAppSelected(select) {
  const [kind, pid, ...nameParts] = state.audioValue.split(':');
  if (kind !== 'include' && kind !== 'exclude') return;
  if ([...select.options].some((o) => o.value === state.audioValue)) return;
  if (!(await liveShare.isProcessAlive(Number(pid)))) return;
  const groupLabel = kind === 'include' ? 'Só o áudio de um app' : 'Todo o áudio, exceto um app';
  const group = [...select.querySelectorAll('optgroup')].find((g) => g.label === groupLabel) || select;
  const name = nameParts.join(':');
  group.appendChild(new Option(`${kind === 'exclude' ? 'Tudo exceto ' : ''}${name} (em segundo plano)`, state.audioValue));
}

async function onAudioSelectChange() {
  state.audioValue = $('audioSelect').value;
  $('discordBadge').hidden = true;
  await applyAudio();
  refreshAudioOptions();
}

// ---------------------------------------------------------------- level meter

// Device audio isn't part of the worklet graph; route it to the analyser too.
function meterFor(track) {
  if (!audioContext || !analyser) return;
  if (meterSource) {
    try { meterSource.disconnect(); } catch { /* already disconnected */ }
    meterSource = null;
  }
  if (track && track !== helperTrack) {
    meterSource = audioContext.createMediaStreamSource(new MediaStream([track]));
    meterSource.connect(analyser);
  }
}

function updateMeter() {
  if (!analyser) return;
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  const sending = state.audioValue !== 'off';
  $('audioMeter').style.width = sending ? Math.min(100, peak * 140) + '%' : '0';
}
