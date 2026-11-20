// Shared clip-grid renderer for the home page and the gallery.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function renderClips({ statusEl, grid, limit, emptyText }) {
  try {
    const res = await fetch(limit ? `/api/clips?limit=${limit}` : '/api/clips');
    const { clips = [] } = await res.json();

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
