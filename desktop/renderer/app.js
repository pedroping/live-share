/* global liveShare, RollingClipRecorder, pcmWorkletModule */
const $ = (id) => document.getElementById(id);
const DEFAULT_SERVER = 'https://live-share-wexj.onrender.com';
const params = new URLSearchParams(location.search);

const QUALITY = {
  '720p30': { width: 1280, height: 720, frameRate: 30, bitrate: 4_000_000 },
  '1080p30': { width: 1920, height: 1080, frameRate: 30, bitrate: 8_000_000 },
  '1080p60': { width: 1920, height: 1080, frameRate: 60, bitrate: 12_000_000 },
  '1440p60': { width: 2560, height: 1440, frameRate: 60, bitrate: 16_000_000 },
};
const MAX_AUDIO_BITRATE = 192_000;
const CLIP_VIDEO_BITRATE = 6_000_000;
const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

const state = {
  selected: null,       // { id, name, kind, hwnd }
  displayStream: null,
  deviceStream: null,
  liveStream: null,
  live: false,
  ws: null,
  code: null,
  clipRecorder: null,
  audioValue: 'except-discord',
};
const peers = new Map();
const outboundStream = new MediaStream();

// ---------------------------------------------------------------- settings
const store = {
  get(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
};
$('serverUrl').value = params.get('server') || store.get('server', DEFAULT_SERVER);
$('serverUrl').addEventListener('change', () => {
  const v = $('serverUrl').value.trim().replace(/\/+$/, '') || DEFAULT_SERVER;
  $('serverUrl').value = v;
  store.set('server', v);
});
$('qualitySelect').value = store.get('quality', '1080p30');
const server = () => $('serverUrl').value.trim().replace(/\/+$/, '') || DEFAULT_SERVER;

// ---------------------------------------------------------------- source picker
function mountPicker(host, onPick) {
  host.innerHTML = '';
  host.appendChild($('pickerTemplate').content.cloneNode(true));
  const grid = host.querySelector('.grid');
  let kind = 'window';
  let timer;

  async function render() {
    const sources = (await liveShare.listSources()).filter((s) => s.kind === kind);
    grid.innerHTML = '';
    if (sources.length === 0) {
      grid.innerHTML = '<div class="empty">Nada para mostrar aqui.</div>';
      return;
    }
    for (const s of sources) {
      const card = document.createElement('button');
      card.className = 'card' + (state.selected?.id === s.id ? ' selected' : '');
      card.innerHTML = `<img class="thumb" alt=""><div class="name">${s.icon ? '<img alt="">' : ''}<span></span></div>`;
      card.querySelector('.thumb').src = s.thumbnail;
      if (s.icon) card.querySelector('.name img').src = s.icon;
      card.querySelector('.name span').textContent = s.name;
      card.title = s.name;
      card.addEventListener('click', () => {
        grid.querySelectorAll('.card').forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
        onPick(s);
      });
      grid.appendChild(card);
    }
  }

  host.querySelectorAll('.tab[data-kind]').forEach((tab) => tab.addEventListener('click', () => {
    host.querySelectorAll('.tab[data-kind]').forEach((t) => t.classList.toggle('active', t === tab));
    kind = tab.dataset.kind;
    render();
  }));
  host.querySelector('[data-action="refresh"]').addEventListener('click', render);
  render();
  timer = setInterval(render, 4000); // live thumbnails, like Discord's picker
  return () => clearInterval(timer);
}

let stopMainPicker = mountPicker($('pickerHost'), (source) => {
  state.selected = source;
  $('goLiveBtn').disabled = false;
  $('goLiveNote').textContent = source.name;
  refreshAudioOptions();
});

// ---------------------------------------------------------------- audio
let audioCtx;
let workletNode;
let helperTrack;
let analyser;

async function ensureHelperTrack() {
  if (helperTrack) return helperTrack;
  audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  const blob = new Blob([`(${pcmWorkletModule.toString()})()`], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  await audioCtx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  workletNode = new AudioWorkletNode(audioCtx, 'pcm-player', { numberOfInputs: 0, outputChannelCount: [2] });
  const dest = audioCtx.createMediaStreamDestination();
  workletNode.connect(dest);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  workletNode.connect(analyser);
  helperTrack = dest.stream.getAudioTracks()[0];
  liveShare.onAudioData((data) => {
    const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    workletNode.port.postMessage(copy, [copy]);
  });
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  return helperTrack;
}

// Level meter for whatever audio is being sent.
let meterSource = null;
function meterFor(track) {
  if (!audioCtx || !analyser) return;
  if (meterSource) { try { meterSource.disconnect(); } catch {} meterSource = null; }
  if (track && track !== helperTrack) {
    meterSource = audioCtx.createMediaStreamSource(new MediaStream([track]));
    meterSource.connect(analyser);
  }
}
setInterval(() => {
  if (!analyser) return;
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  let peak = 0;
  for (const v of data) peak = Math.max(peak, Math.abs(v));
  const hasTrack = !!state.liveStream?.getAudioTracks().length || state.audioValue !== 'off';
  $('audioMeter').style.width = hasTrack ? Math.min(100, peak * 140) + '%' : '0';
}, 100);

liveShare.onAudioStatus((status) => {
  $('audioNote').textContent = status.text;
  $('audioNote').className = 'note ' + (status.ok ? 'ok' : 'warn');
});

async function refreshAudioOptions() {
  const [apps, discord] = await Promise.all([liveShare.listApps(), liveShare.isDiscordRunning()]);
  let devices = [];
  try { devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.label); } catch {}

  const select = $('audioSelect');
  const groups = [
    ['Recomendado', [
      ['except-discord', '🔊 Todo o áudio do sistema, exceto Discord'],
      ...(state.selected?.kind === 'window' ? [['window', `🪟 Só o áudio de "${state.selected.name.slice(0, 40)}"`]] : []),
      ['system', 'Todo o áudio do sistema (inclui Discord)'],
      ['off', '🔇 Sem áudio'],
    ]],
    ['Só o áudio de um app', apps.map((a) => [`include:${a.pid}:${a.name}`, a.name])],
    ['Todo o áudio, exceto um app', apps.map((a) => [`exclude:${a.pid}:${a.name}`, `Tudo exceto ${a.name}`])],
    ['Dispositivo de entrada (microfone, VB-Cable…)', devices.map((d) => [`device:${d.deviceId}`, d.label])],
  ];
  select.innerHTML = '';
  for (const [label, options] of groups) {
    if (!options.length) continue;
    const group = document.createElement('optgroup');
    group.label = label;
    for (const [value, text] of options) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      group.appendChild(o);
    }
    select.appendChild(group);
  }
  let fellBack = false;
  if (![...select.options].some((o) => o.value === state.audioValue)) {
    // The chosen app/device went away: fall back to the Discord-safe default.
    state.audioValue = 'except-discord';
    fellBack = true;
  }
  select.value = state.audioValue;
  $('discordBadge').hidden = !(discord && state.audioValue === 'except-discord');
  if (fellBack && audioApplied) await applyAudio();
}
let audioApplied = false;

$('audioSelect').addEventListener('change', async () => {
  state.audioValue = $('audioSelect').value;
  $('discordBadge').hidden = true;
  await applyAudio();
  refreshAudioOptions();
});

function helperModeFor(value) {
  if (value === 'except-discord') return { type: 'except-discord' };
  if (value === 'system') return { type: 'system' };
  if (value === 'window') return { type: 'window', hwnd: state.selected?.hwnd };
  const [kind, pid, ...name] = value.split(':');
  if (kind === 'include' || kind === 'exclude') return { type: kind, pid: Number(pid), name: name.join(':') };
  return null;
}

// Pick the audio track for the current choice and push it live.
async function applyAudio() {
  audioApplied = true;
  const value = state.audioValue;
  const helperMode = helperModeFor(value);
  const previousDevice = state.deviceStream;
  state.deviceStream = null;

  if (helperMode) {
    await ensureHelperTrack();
    workletNode.port.postMessage('reset');
    await liveShare.setAudioMode(helperMode);
  } else {
    await liveShare.setAudioMode({ type: 'off' });
    if (value.startsWith('device:')) {
      try {
        state.deviceStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: value.slice(7) },
            echoCancellation: false, noiseSuppression: false, autoGainControl: false,
            channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 },
          },
        });
        $('audioNote').textContent = 'Enviando: ' + state.deviceStream.getAudioTracks()[0].label;
        $('audioNote').className = 'note ok';
      } catch (e) {
        $('audioNote').textContent = 'Não foi possível abrir o dispositivo: ' + e.message;
        $('audioNote').className = 'note warn';
      }
    } else {
      $('audioNote').textContent = 'A transmissão vai sem áudio.';
      $('audioNote').className = 'note';
    }
  }
  if (state.live) await applyLiveStream();
  if (previousDevice && previousDevice !== state.deviceStream) previousDevice.getTracks().forEach((t) => t.stop());
}

function currentAudioTrack() {
  if (helperModeFor(state.audioValue)) return helperTrack || null;
  if (state.deviceStream) return state.deviceStream.getAudioTracks()[0] || null;
  return null;
}

// ---------------------------------------------------------------- video capture
async function captureSource(source) {
  const q = QUALITY[$('qualitySelect').value];
  await liveShare.selectSource(source.id);
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { width: { max: q.width }, height: { max: q.height }, frameRate: { ideal: q.frameRate, max: q.frameRate } },
    audio: false,
  });
  const track = stream.getVideoTracks()[0];
  if ('contentHint' in track) track.contentHint = q.frameRate >= 60 ? 'motion' : 'detail';
  track.addEventListener('ended', () => {
    // The shared window was closed.
    if (state.live && state.displayStream === stream) stopLive('A janela compartilhada foi fechada.');
  });
  return stream;
}

$('qualitySelect').addEventListener('change', async () => {
  store.set('quality', $('qualitySelect').value);
  if (!state.live) return;
  const q = QUALITY[$('qualitySelect').value];
  const track = state.displayStream.getVideoTracks()[0];
  await track.applyConstraints({ width: { max: q.width }, height: { max: q.height }, frameRate: { ideal: q.frameRate, max: q.frameRate } }).catch(() => {});
  for (const pc of peers.values()) await applySenderLimits(pc);
});

async function applyLiveStream() {
  const tracks = [state.displayStream.getVideoTracks()[0], currentAudioTrack()].filter(Boolean);
  state.liveStream = new MediaStream(tracks);
  $('preview').srcObject = new MediaStream([tracks[0]]);
  outboundStream.getTracks().forEach((t) => outboundStream.removeTrack(t));
  tracks.forEach((t) => outboundStream.addTrack(t));
  await Promise.all([...peers.values()].map((pc) => swapTracks(pc, state.liveStream)));
  await state.clipRecorder?.setStream(state.liveStream);
  meterFor(currentAudioTrack());
}

// ---------------------------------------------------------------- go live / stop
$('goLiveBtn').addEventListener('click', goLive);

async function goLive() {
  if (!state.selected) return;
  $('goLiveBtn').disabled = true;
  $('goLiveNote').textContent = 'Conectando…';
  try {
    state.displayStream = await captureSource(state.selected);
    await applyAudio();
    state.live = true;
    await applyLiveStream();
  } catch (e) {
    $('goLiveBtn').disabled = false;
    $('goLiveNote').textContent = 'Erro ao capturar: ' + e.message;
    return;
  }
  stopMainPicker();
  $('pickerView').style.display = 'none';
  $('liveView').style.display = 'block';
  $('liveSourceName').textContent = state.selected.name;
  $('goLiveBox').hidden = true;
  $('liveBox').hidden = false;
  $('statePill').textContent = 'AO VIVO';
  $('statePill').classList.add('live');
  connectSignaling();
}

$('stopBtn').addEventListener('click', () => stopLive());

function stopLive(reason) {
  state.live = false;
  state.clipRecorder?.stop();
  state.clipRecorder = null;
  for (const pc of peers.values()) pc.close();
  peers.clear();
  if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
  state.displayStream?.getTracks().forEach((t) => t.stop());
  state.displayStream = null;
  liveShare.setAudioMode({ type: 'off' });
  if (reason) alert(reason);
  location.reload();
}

// Switch source without ending the stream.
let stopOverlayPicker = null;
$('switchBtn').addEventListener('click', () => {
  $('pickerOverlay').style.display = 'block';
  stopOverlayPicker = mountPicker($('overlayPickerHost'), async (source) => {
    closeOverlay();
    const previous = state.displayStream;
    try {
      state.selected = source;
      state.displayStream = await captureSource(source);
      $('liveSourceName').textContent = source.name;
      if (state.audioValue === 'window' && source.kind !== 'window') state.audioValue = 'except-discord';
      await refreshAudioOptions();
      if (state.audioValue === 'window') await applyAudio(); // follow the new window's app
      else await applyLiveStream();
      previous?.getTracks().forEach((t) => t.stop());
    } catch (e) {
      state.displayStream = previous;
      alert('Não foi possível trocar a fonte: ' + e.message);
    }
  });
});
function closeOverlay() {
  $('pickerOverlay').style.display = 'none';
  stopOverlayPicker?.();
  stopOverlayPicker = null;
}
$('closePickerBtn').addEventListener('click', closeOverlay);

$('copyBtn').addEventListener('click', async () => {
  await liveShare.copy($('watchLink').textContent);
  $('copyBtn').textContent = '✅ Copiado!';
  setTimeout(() => { $('copyBtn').textContent = '📋 Copiar link'; }, 2000);
});
$('openBtn').addEventListener('click', () => liveShare.openExternal($('watchLink').textContent));

// ---------------------------------------------------------------- signaling
function sendSignal(message) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
  state.ws.send(JSON.stringify(message));
  return true;
}

function connectSignaling() {
  const ws = new WebSocket(server().replace(/^http/, 'ws'));
  state.ws = ws;
  ws.onopen = () => sendSignal({ type: 'create-room' });
  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'room-created') {
      state.code = msg.code;
      $('code').textContent = msg.code;
      $('watchLink').textContent = `${server()}/watch.html?code=${msg.code}`;
      console.log('LIVESHARE_ROOM ' + msg.code);
    } else if (msg.type === 'viewer-joined') {
      ensureClipRecorder();
      await addViewer(msg.viewerId);
    } else if (msg.type === 'answer') {
      const pc = peers.get(msg.from);
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    } else if (msg.type === 'ice-candidate') {
      const pc = peers.get(msg.from);
      if (pc && msg.candidate) { try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {} }
    } else if (msg.type === 'viewer-left') {
      const pc = peers.get(msg.viewerId);
      if (pc) { pc.close(); peers.delete(msg.viewerId); }
      stopClipRecorderWithoutViewers();
      updateViewers();
    } else if (msg.type === 'clip-request') {
      uploadRequestedClip(msg);
    }
  };
  ws.onclose = () => {
    if (!state.live) return;
    $('code').textContent = '····';
    $('watchLink').textContent = 'Reconectando ao servidor…';
    setTimeout(() => { if (state.live) { peers.forEach((pc) => pc.close()); peers.clear(); updateViewers(); connectSignaling(); } }, 3000);
  };
}

function updateViewers() {
  $('viewers').textContent = `Espectadores: ${peers.size}`;
}

// ---------------------------------------------------------------- peers
async function sendOffer(pc) {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSignal({ type: 'offer', target: pc.viewerId, sdp: offer });
}

async function applySenderLimits(pc) {
  const q = QUALITY[$('qualitySelect').value];
  for (const sender of pc.getSenders()) {
    const limit = sender.kindHint === 'video' ? q.bitrate : sender.kindHint === 'audio' ? MAX_AUDIO_BITRATE : 0;
    if (!limit) continue;
    const p = sender.getParameters();
    if (!p.encodings?.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = limit;
    if (sender.kindHint === 'video') p.encodings[0].maxFramerate = q.frameRate;
    await sender.setParameters(p).catch(() => {});
  }
}

function preferHardwareCodec(pc) {
  const t = pc.getTransceivers().find((x) => x.sender?.track?.kind === 'video');
  const codecs = RTCRtpSender.getCapabilities?.('video')?.codecs;
  if (!t?.setCodecPreferences || !codecs?.length) return;
  const h264 = codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
  if (!h264.length) return;
  try { t.setCodecPreferences([...h264, ...codecs.filter((c) => c.mimeType.toLowerCase() !== 'video/h264')]); } catch {}
}

async function swapTracks(pc, stream) {
  let needsOffer = false;
  for (const kind of ['video', 'audio']) {
    const track = stream.getTracks().find((t) => t.kind === kind) || null;
    const sender = pc.getSenders().find((s) => s.kindHint === kind);
    if (sender) await sender.replaceTrack(track);
    else if (track) { pc.addTrack(track, outboundStream).kindHint = kind; needsOffer = true; }
  }
  if (needsOffer) { await sendOffer(pc); await applySenderLimits(pc); }
}

async function addViewer(viewerId) {
  const pc = new RTCPeerConnection({ iceServers });
  pc.viewerId = viewerId;
  peers.set(viewerId, pc);
  state.liveStream.getTracks().forEach((track) => { pc.addTrack(track, outboundStream).kindHint = track.kind; });
  preferHardwareCodec(pc);
  await applySenderLimits(pc);
  pc.addEventListener('connectionstatechange', () => {
    if (['failed', 'closed'].includes(pc.connectionState)) {
      pc.close();
      peers.delete(viewerId);
      stopClipRecorderWithoutViewers();
      updateViewers();
    }
  });
  pc.onicecandidate = (e) => { if (e.candidate) sendSignal({ type: 'ice-candidate', target: viewerId, candidate: e.candidate }); };
  await sendOffer(pc);
  updateViewers();
}

// ---------------------------------------------------------------- clips
function ensureClipRecorder() {
  if (state.clipRecorder) return;
  state.clipRecorder = new RollingClipRecorder(state.liveStream, { videoBitsPerSecond: CLIP_VIDEO_BITRATE });
  state.clipRecorder.start();
}
function stopClipRecorderWithoutViewers() {
  if (peers.size > 0 || !state.clipRecorder) return;
  state.clipRecorder.stop();
  state.clipRecorder = null;
}
async function uploadRequestedClip({ requestId, duration }) {
  if (!state.clipRecorder) return sendSignal({ type: 'clip-upload-failed', requestId });
  try {
    const selection = await state.clipRecorder.select(duration);
    if (!selection.segments.length) throw new Error('Nenhum segmento disponível.');
    const form = new FormData();
    selection.segments.forEach((s, i) => form.append('videos', s.blob, `segmento-${i}.webm`));
    form.append('startOffsetMs', String(selection.startOffsetMs));
    form.append('segmentDurationsMs', JSON.stringify(selection.segments.map((s) => s.durationMs)));
    const res = await fetch(`${server()}/api/clips`, { method: 'POST', headers: { 'X-Clip-Request': requestId }, body: form });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (e) {
    console.error('clip upload failed', e);
    sendSignal({ type: 'clip-upload-failed', requestId });
  }
}

// ---------------------------------------------------------------- startup
(async () => {
  // Device names stay hidden until media permission is granted once.
  try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop()); } catch {}
  await refreshAudioOptions();
  navigator.mediaDevices.addEventListener('devicechange', refreshAudioOptions);
  setInterval(() => { if (!document.hidden) refreshAudioOptions(); }, 15000);

  // Test hook: auto-pick the first screen and go live with a given audio mode.
  if (params.get('autotest')) {
    state.selected = (await liveShare.listSources()).find((s) => s.kind === 'screen');
    if (params.get('audio')) state.audioValue = params.get('audio');
    await goLive();
    return;
  }
  await applyAudio(); // start the level meter with the default (exclude Discord)
})();
