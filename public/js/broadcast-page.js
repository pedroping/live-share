// Web broadcast page: capture the screen in the browser, pick an audio
// source, and go live. Rooms, viewers, reconnects and clips are handled by
// BroadcastSession (broadcast-session.js), shared with the desktop app.
//
// Audio sources:
//   display      the system/tab audio offered by the browser's screen picker
//   none         video only
//   device:<id>  a microphone or virtual cable (e.g. VB-Cable "CABLE Output")
const AUDIO_DISPLAY = 'display';
const AUDIO_NONE = 'none';
const AUDIO_ASK_PERMISSION = 'grant'; // placeholder until device names are visible

// Raw audio: voice-call processing (echo/noise/gain) mangles music and games.
const RAW_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

const $ = (id) => document.getElementById(id);
const startBtn = $('startBtn');
const serverStatus = $('serverStatus');
const audioSelect = $('audioSource');
const audioStatus = $('audioStatus');
const audioHint = $('audioHint');
const codeBox = $('codeBox');
const codeDisplay = $('codeDisplay');
const watchLink = $('watchLink');
const copyBtn = $('copyBtn');
const viewerCount = $('viewerCount');
const controls = $('controls');
const switchBtn = $('switchBtn');
const preview = $('preview');

let displayStream = null; // the screen capture (video + maybe its audio)
let deviceStream = null;  // the input device, when one is chosen
let liveStream = null;    // what is sent: screen video + chosen audio
let audioMode = AUDIO_DISPLAY;
let session = null;

// ---------------------------------------------------------------- screen capture

function screenCaptureOptions() {
  const wantAudio = audioMode === AUDIO_DISPLAY;
  return {
    video: {
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 30, max: 30 },
    },
    audio: wantAudio ? { ...RAW_AUDIO, suppressLocalAudioPlayback: false } : false,
    systemAudio: wantAudio ? 'include' : 'exclude',   // offer "Share system audio"
    windowAudio: wantAudio ? 'system' : 'exclude',
    monitorTypeSurfaces: 'include',                  // keep "Entire screen" available
    surfaceSwitching: 'include',                     // Chrome's "Share this tab instead"
    selfBrowserSurface: 'exclude',                   // don't offer this tab (mirror effect)
  };
}

async function captureScreen() {
  const stream = await navigator.mediaDevices.getDisplayMedia(screenCaptureOptions());
  const videoTrack = stream.getVideoTracks()[0];
  if ('contentHint' in videoTrack) videoTrack.contentHint = 'detail';
  const audioTrack = stream.getAudioTracks()[0];
  if (audioTrack && 'contentHint' in audioTrack) audioTrack.contentHint = 'music';
  return stream;
}

// The browser's own "Stop sharing" button ends the broadcast.
function onCaptureEnded() {
  session?.stop();
  deviceStream?.getTracks().forEach((t) => t.stop());
  location.reload();
}

function useDisplayStream(stream) {
  const previous = displayStream;
  previous?.getVideoTracks()[0]?.removeEventListener('ended', onCaptureEnded);
  displayStream = stream;
  stream.getVideoTracks()[0].addEventListener('ended', onCaptureEnded);
  return previous;
}

// Screen video + the chosen audio, pushed to viewers if live.
async function updateLiveStream() {
  const tracks = [displayStream.getVideoTracks()[0], currentAudioTrack()].filter(Boolean);
  liveStream = new MediaStream(tracks);
  preview.srcObject = liveStream;
  await session?.updateStream(liveStream);
  showAudioStatus();
}

// ---------------------------------------------------------------- going live

async function goLive() {
  let stream;
  try {
    stream = await captureScreen();
  } catch (err) {
    alert('Não foi possível capturar a tela: ' + err.message);
    return;
  }
  useDisplayStream(stream);
  await updateLiveStream();
  startBtn.style.display = 'none';
  controls.style.display = 'flex';

  session = new BroadcastSession({
    serverUrl: '',
    getStream: () => liveStream,
    getVideoLimits: () => ({ bitrate: 8_000_000, frameRate: 30 }),
    onServerStatus: (status) => {
      if (status.state !== 'online') serverStatus.textContent = ServerWake.describe(status);
    },
    onReconnecting: (reconnecting) => {
      serverStatus.textContent = reconnecting
        ? 'Reconectando ao servidor… quem já está assistindo continua vendo normalmente.'
        : '';
    },
    onRoom: ({ code, link }) => {
      codeBox.style.display = 'block';
      codeDisplay.textContent = code;
      watchLink.textContent = link;
    },
    onViewerCount: (count) => { viewerCount.textContent = `Espectadores conectados: ${count}`; },
  });

  if (!(await session.start())) {
    session = null;
    stream.getTracks().forEach((t) => t.stop());
    alert(ServerWake.describe({ state: 'offline' }));
    location.reload();
    return;
  }
  showAudioStatus();
}

async function switchVideoSource() {
  switchBtn.disabled = true;
  let stream;
  try {
    stream = await captureScreen();
  } catch {
    switchBtn.disabled = false; // picker cancelled: keep the current source
    return;
  }
  const previous = useDisplayStream(stream);
  try {
    await updateLiveStream();
  } catch (error) {
    console.error('Erro ao trocar a fonte:', error);
  } finally {
    previous?.getTracks().forEach((t) => t.stop());
    switchBtn.disabled = false;
  }
}

// ---------------------------------------------------------------- copy link

async function copyLink() {
  try {
    await navigator.clipboard.writeText(watchLink.textContent);
  } catch {
    // Fallback for browsers that block the async clipboard API.
    const range = document.createRange();
    range.selectNodeContents(watchLink);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('copy');
    selection.removeAllRanges();
  }
  copyBtn.textContent = '✅ Copiado!';
  copyBtn.classList.add('copied');
  clearTimeout(copyBtn.resetTimer);
  copyBtn.resetTimer = setTimeout(() => {
    copyBtn.textContent = '📋 Copiar link';
    copyBtn.classList.remove('copied');
  }, 2000);
}

// ---------------------------------------------------------------- audio source

function currentAudioTrack() {
  if (audioMode === AUDIO_DISPLAY) return displayStream?.getAudioTracks()[0] || null;
  if (audioMode.startsWith('device:')) return deviceStream?.getAudioTracks()[0] || null;
  return null;
}

async function refreshAudioOptions() {
  let devices = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  } catch { /* no device access */ }

  const options = [
    [AUDIO_DISPLAY, 'Áudio do sistema / aba (da captura de tela)'],
    [AUDIO_NONE, 'Sem áudio'],
  ];
  // Browsers hide device names until the site gets microphone permission.
  if (devices.some((d) => d.label)) {
    devices
      .filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .forEach((d) => options.push([`device:${d.deviceId}`, `🎚️ ${d.label}`]));
  } else {
    options.push([AUDIO_ASK_PERMISSION, '🎚️ Usar um dispositivo de entrada… (pede permissão)']);
  }

  audioSelect.innerHTML = '';
  for (const [value, label] of options) audioSelect.add(new Option(label, value));

  // The chosen device was unplugged: fall back to no audio.
  if (![...audioSelect.options].some((o) => o.value === audioMode) && audioMode.startsWith('device:')) {
    await setAudioMode(AUDIO_NONE);
  }
  audioSelect.value = audioMode;
  updateAudioHint();
}

async function openInputDevice(deviceId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: deviceId }, ...RAW_AUDIO, channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 } },
    video: false,
  });
  const track = stream.getAudioTracks()[0];
  if (track && 'contentHint' in track) track.contentHint = 'music';
  track?.addEventListener('ended', () => {
    // Device unplugged mid-stream: continue without audio.
    if (deviceStream === stream) {
      setAudioMode(AUDIO_NONE).then(() => { audioSelect.value = AUDIO_NONE; updateAudioHint(); });
    }
  });
  return stream;
}

async function setAudioMode(mode) {
  const previousDevice = deviceStream;
  deviceStream = mode.startsWith('device:') ? await openInputDevice(mode.slice('device:'.length)) : null;
  audioMode = mode;
  if (displayStream) await updateLiveStream();
  if (previousDevice && previousDevice !== deviceStream) previousDevice.getTracks().forEach((t) => t.stop());
  showAudioStatus();
}

async function onAudioSelectChange() {
  const value = audioSelect.value;
  audioSelect.disabled = true;
  try {
    if (value === AUDIO_ASK_PERMISSION) {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
      await refreshAudioOptions();
      const firstDevice = [...audioSelect.options].find((o) => o.value.startsWith('device:'));
      audioSelect.value = firstDevice ? firstDevice.value : audioMode;
      if (firstDevice) await setAudioMode(firstDevice.value);
    } else {
      await setAudioMode(value);
    }
  } catch (error) {
    alert('Não foi possível usar essa fonte de áudio: ' + error.message);
    audioSelect.value = audioMode;
  } finally {
    audioSelect.disabled = false;
    updateAudioHint();
  }
}

function updateAudioHint() {
  if (audioMode === AUDIO_DISPLAY) {
    audioHint.innerHTML = 'Escolha <b>Tela inteira</b> e marque <b>Compartilhar áudio do sistema</b> para enviar ' +
      'todo o som do computador (Chrome/Edge no Windows), ou escolha uma <b>Aba</b> para enviar só o som dela.';
  } else if (audioMode.startsWith('device:')) {
    audioHint.innerHTML = 'Só o som desse dispositivo é enviado. Para excluir o Discord: mande o jogo/música para ' +
      '<b>CABLE Input</b> (VB-Cable) no Mixer de volume do Windows e escolha <b>CABLE Output</b> aqui.';
  } else {
    audioHint.textContent = '';
  }
}

function showAudioStatus() {
  if (!session) {
    audioStatus.textContent = '';
    return;
  }
  const track = liveStream?.getAudioTracks()[0];
  if (track) audioStatus.textContent = `🔊 Enviando áudio: ${track.label || 'áudio'}`;
  else if (audioMode === AUDIO_DISPLAY) audioStatus.textContent = '🔇 A captura atual não tem áudio. Use "Trocar fonte de vídeo" e marque "Compartilhar áudio".';
  else audioStatus.textContent = '🔇 Sem áudio';
  audioStatus.classList.toggle('off', !track);
}

// ---------------------------------------------------------------- startup

startBtn.addEventListener('click', goLive);
switchBtn.addEventListener('click', switchVideoSource);
copyBtn.addEventListener('click', copyLink);
audioSelect.addEventListener('change', onAudioSelectChange);
navigator.mediaDevices.addEventListener?.('devicechange', refreshAudioOptions);
// Closing the tab ends the room right away instead of after the grace period.
window.addEventListener('pagehide', () => session?.sendEndRoom());
refreshAudioOptions();
