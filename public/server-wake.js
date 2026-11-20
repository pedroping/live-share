// Render's free plan puts the server to sleep after ~15 minutes without
// traffic, and the first request then takes ~30-60s while it boots.
// ServerWake checks /healthz, keeps retrying while the server wakes up
// (reporting progress so the UI can say so), and can keep it awake while a
// broadcast or viewer session is active.
(function exposeServerWake(globalScope) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function ping(base = '', timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}/healthz?t=${Date.now()}`, { cache: 'no-store', signal: controller.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  // Resolves true once the server answers, false after maxWaitMs.
  // onStatus({ state: 'checking' | 'waking' | 'online' | 'offline', elapsed })
  async function wakeServer(base = '', { onStatus, maxWaitMs = 120_000 } = {}) {
    const started = Date.now();
    const elapsed = () => Math.round((Date.now() - started) / 1000);
    onStatus?.({ state: 'checking', elapsed: 0 });
    if (await ping(base, 4000)) {
      onStatus?.({ state: 'online', elapsed: elapsed() });
      return true;
    }
    // A sleeping Render service holds the first request while it boots, so
    // keep a long-timeout ping in flight and tick the UI meanwhile.
    const ticker = setInterval(() => onStatus?.({ state: 'waking', elapsed: elapsed() }), 1000);
    onStatus?.({ state: 'waking', elapsed: elapsed() });
    try {
      while (Date.now() - started < maxWaitMs) {
        if (await ping(base, 20_000)) {
          onStatus?.({ state: 'online', elapsed: elapsed() });
          return true;
        }
        await sleep(2000);
      }
    } finally {
      clearInterval(ticker);
    }
    onStatus?.({ state: 'offline', elapsed: elapsed() });
    return false;
  }

  // Ping every few minutes so the server never idles out mid-session.
  function keepAlive(base = '', intervalMs = 4 * 60 * 1000) {
    const id = setInterval(() => { ping(base, 20_000); }, intervalMs);
    return () => clearInterval(id);
  }

  // Default Portuguese status text for the pages.
  function describe(status) {
    switch (status.state) {
      case 'checking': return 'Verificando o servidor...';
      case 'waking': return `O servidor estava dormindo e está acordando (${status.elapsed}s, pode levar até 1 minuto)...`;
      case 'online': return '';
      default: return 'Não foi possível acordar o servidor. Tente de novo em instantes.';
    }
  }

  globalScope.ServerWake = { ping, wakeServer, keepAlive, describe };
  if (typeof module !== 'undefined') module.exports = globalScope.ServerWake;
})(typeof window !== 'undefined' ? window : globalThis);
