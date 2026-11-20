// Shared clip-grid renderer for the home page and the gallery.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function fetchClips(limit) {
  const res = await fetch(limit ? `/api/clips?limit=${limit}` : '/api/clips', { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function renderClips({ statusEl, grid, limit, emptyText }) {
  try {
    let data;
    try {
      data = await fetchClips(limit);
    } catch {
      // Server asleep (Render free plan) or restarting: wake it, then retry.
      const awake = await ServerWake.wakeServer('', {
        onStatus: (s) => { statusEl.textContent = ServerWake.describe(s) || 'Carregando...'; },
      });
      if (!awake) throw new Error('offline');
      data = await fetchClips(limit);
    }
    const { clips = [] } = data;

    if (clips.length === 0) {
      statusEl.textContent = emptyText;
      return;
    }

    statusEl.textContent = '';
    grid.innerHTML = clips.map((c) => `
      <div class="card">
        <video controls preload="none" poster="${escapeHtml(c.posterUrl || '')}" src="${escapeHtml(c.url)}"></video>
        <div class="meta">
          <span>Sala: ${escapeHtml(c.code || '—')}${c.duration ? ` · ${c.duration}s` : ''}</span>
          <span>${new Date(c.createdAt).toLocaleString('pt-BR')}</span>
        </div>
      </div>
    `).join('');
  } catch (err) {
    statusEl.textContent = 'Erro ao carregar os clipes.';
  }
}
