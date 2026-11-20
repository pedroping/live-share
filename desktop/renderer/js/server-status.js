// The server pill in the header. Render's free plan sleeps after ~15 minutes
// idle and takes up to a minute to wake, so the app starts waking it at launch
// and shows progress here.
let wakeInFlight = null;

function showServerStatus(status) {
  const pill = $('serverPill');
  pill.classList.remove('online', 'waking', 'offline');
  if (status.state === 'online') {
    pill.textContent = '● Servidor online';
    pill.classList.add('online');
  } else if (status.state === 'checking') {
    pill.textContent = 'Verificando servidor…';
  } else if (status.state === 'waking') {
    pill.textContent = `Acordando servidor… ${status.elapsed}s`;
    pill.classList.add('waking');
  } else {
    pill.textContent = 'Servidor offline · tentar de novo';
    pill.classList.add('offline');
  }

  if (state.live) return;
  const note = $('goLiveNote');
  if (status.state === 'waking') {
    note.textContent = 'O servidor gratuito estava dormindo; acordando (até ~1 min)…';
  } else if (status.state === 'online' && note.textContent.includes('dormindo')) {
    note.textContent = state.selected ? state.selected.name : 'Selecione uma tela ou janela.';
  }
}

// Resolves true once the server answers. Concurrent calls share one attempt.
function ensureServer() {
  if (!wakeInFlight) {
    wakeInFlight = ServerWake.wakeServer(serverUrl(), { onStatus: showServerStatus })
      .finally(() => { setTimeout(() => { wakeInFlight = null; }, 0); });
  }
  return wakeInFlight;
}
