// Going live, switching the video source while live, and stopping.
// Rooms, viewers, reconnects and clips are handled by BroadcastSession
// (shared with the website, see public/js/broadcast-session.js).

// ---------------------------------------------------------------- capture

async function captureSource(source) {
  const q = currentQuality();
  await liveShare.selectSource(source.id); // main process hands this source to getDisplayMedia
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { width: { max: q.width }, height: { max: q.height }, frameRate: { ideal: q.frameRate, max: q.frameRate } },
    audio: false, // audio comes from appaudio.exe or a device, see audio.js
  });
  const track = stream.getVideoTracks()[0];
  if ('contentHint' in track) track.contentHint = q.frameRate >= 60 ? 'motion' : 'detail';
  track.addEventListener('ended', () => {
    if (state.live && state.displayStream === stream) stopLive('A janela compartilhada foi fechada.');
  });
  return stream;
}

// Video + chosen audio; sent to every viewer when live.
async function updateLiveStream() {
  const videoTrack = state.displayStream.getVideoTracks()[0];
  state.liveStream = new MediaStream([videoTrack, currentAudioTrack()].filter(Boolean));
  $('preview').srcObject = new MediaStream([videoTrack]);
  await state.session?.updateStream(state.liveStream);
  meterFor(currentAudioTrack());
}

async function onQualityChange() {
  store.set('quality', $('qualitySelect').value);
  if (!state.live) return;
  const q = currentQuality();
  await state.displayStream.getVideoTracks()[0]
    .applyConstraints({ width: { max: q.width }, height: { max: q.height }, frameRate: { ideal: q.frameRate, max: q.frameRate } })
    .catch(() => {});
  await state.session.applyLimits();
}

// ---------------------------------------------------------------- go live / stop

async function goLive() {
  if (!state.selected) return;
  $('goLiveBtn').disabled = true;
  $('goLiveNote').textContent = 'Conectando…';

  try {
    state.displayStream = await captureSource(state.selected);
    await applyAudio();
    state.live = true;
    await updateLiveStream();
  } catch (e) {
    state.live = false;
    $('goLiveBtn').disabled = false;
    $('goLiveNote').textContent = 'Erro ao capturar: ' + e.message;
    return;
  }

  state.session = new BroadcastSession({
    serverUrl: serverUrl(),
    getStream: () => state.liveStream,
    getVideoLimits: () => currentQuality(),
    onServerStatus: showServerStatus,
    onReconnecting: (reconnecting) => { $('reconnectNote').hidden = !reconnecting; },
    onRoom: ({ code, link }) => {
      $('code').textContent = code;
      $('watchLink').textContent = link;
      console.log('LIVESHARE_ROOM ' + code); // read by the automated tests
    },
    onViewerCount: (count) => { $('viewers').textContent = `Espectadores: ${count}`; },
  });

  if (!(await state.session.start())) {
    state.session = null;
    state.live = false;
    state.displayStream.getTracks().forEach((t) => t.stop());
    $('goLiveBtn').disabled = false;
    $('goLiveNote').textContent = 'Não consegui acordar o servidor. Confira a internet/URL e tente de novo.';
    return;
  }
  showLiveView();
}

function showLiveView() {
  stopMainPicker();
  $('pickerView').style.display = 'none';
  $('liveView').style.display = 'block';
  $('liveSourceName').textContent = state.selected.name;
  $('goLiveBox').hidden = true;
  $('liveBox').hidden = false;
  $('statePill').textContent = 'AO VIVO';
  $('statePill').classList.add('live');
}

function stopLive(reason) {
  state.live = false;
  state.session?.stop();
  state.session = null;
  state.displayStream?.getTracks().forEach((t) => t.stop());
  state.displayStream = null;
  liveShare.setAudioMode({ type: 'off' });
  if (reason) alert(reason);
  location.reload();
}

// ---------------------------------------------------------------- switch source while live

let stopOverlayPicker = null;

function openSourceSwitcher() {
  $('pickerOverlay').style.display = 'block';
  stopOverlayPicker = mountSourcePicker($('overlayPickerHost'), switchToSource);
}

function closeSourceSwitcher() {
  $('pickerOverlay').style.display = 'none';
  stopOverlayPicker?.();
  stopOverlayPicker = null;
}

async function switchToSource(source) {
  closeSourceSwitcher();
  const previous = state.displayStream;
  try {
    state.selected = source;
    state.displayStream = await captureSource(source);
    $('liveSourceName').textContent = source.name;
    // "Only this window's app" can't apply to a screen.
    if (state.audioValue === 'window' && source.kind !== 'window') state.audioValue = DEFAULT_AUDIO;
    await refreshAudioOptions();
    if (state.audioValue === 'window') await applyAudio(); // follow the new window's app
    else await updateLiveStream();
    previous?.getTracks().forEach((t) => t.stop());
  } catch (e) {
    state.displayStream = previous;
    alert('Não foi possível trocar a fonte: ' + e.message);
  }
}

// ---------------------------------------------------------------- share link

async function copyWatchLink() {
  await liveShare.copy($('watchLink').textContent);
  $('copyBtn').textContent = '✅ Copiado!';
  setTimeout(() => { $('copyBtn').textContent = '📋 Copiar link'; }, 2000);
}
