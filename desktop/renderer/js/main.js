// Startup: restore settings, wire up the buttons, start waking the server.

// ---------------------------------------------------------------- settings
$('serverUrl').value = params.get('server') || store.get('server', DEFAULT_SERVER);
$('qualitySelect').value = store.get('quality', '1080p30');

$('serverUrl').addEventListener('change', () => {
  $('serverUrl').value = serverUrl(); // normalize (trailing slash, empty -> default)
  store.set('server', serverUrl());
  ensureServer();
});
$('serverPill').addEventListener('click', ensureServer);
$('qualitySelect').addEventListener('change', onQualityChange);
$('audioSelect').addEventListener('change', onAudioSelectChange);

// ---------------------------------------------------------------- buttons
$('goLiveBtn').addEventListener('click', goLive);
$('stopBtn').addEventListener('click', () => stopLive());
$('switchBtn').addEventListener('click', openSourceSwitcher);
$('closePickerBtn').addEventListener('click', closeSourceSwitcher);
$('copyBtn').addEventListener('click', copyWatchLink);
$('openBtn').addEventListener('click', () => liveShare.openExternal($('watchLink').textContent));

// Closing the window ends the room right away instead of after the grace period.
window.addEventListener('beforeunload', () => state.session?.sendEndRoom());

liveShare.onAudioStatus((status) => setAudioNote(status.text, status.ok ? 'ok' : 'warn'));
setInterval(updateMeter, 100);

// ---------------------------------------------------------------- source picker
const stopMainPicker = mountSourcePicker($('pickerHost'), (source) => {
  state.selected = source;
  $('goLiveBtn').disabled = false;
  $('goLiveNote').textContent = source.name;
  refreshAudioOptions();
});

// ---------------------------------------------------------------- start
(async () => {
  ensureServer(); // start waking it now, before the user picks a source

  // Device names stay hidden until media permission is granted once.
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((t) => t.stop());
  } catch { /* no microphone: devices just won't be listed */ }

  await refreshAudioOptions();
  navigator.mediaDevices.addEventListener('devicechange', refreshAudioOptions);
  setInterval(() => { if (!document.hidden) refreshAudioOptions(); }, 15_000);

  if (params.get('autotest')) {
    // Automated tests (desktop/test/e2e.js): pick the first screen, go live.
    state.selected = (await liveShare.listSources()).find((s) => s.kind === 'screen');
    if (params.get('audio')) state.audioValue = params.get('audio');
    await goLive();
    return;
  }
  await applyAudio(); // start the level meter with the default (exclude Discord)
})();
