// The Discord-style picker: tabs for apps and screens, live thumbnails.
// Mounted in the main view, and again in the "Trocar fonte" overlay.

/**
 * @param {HTMLElement} host       where to render the picker
 * @param {(source) => void} onPick called with { id, name, kind, hwnd, ... }
 * @returns {() => void} call to stop refreshing thumbnails
 */
function mountSourcePicker(host, onPick) {
  host.innerHTML = '';
  host.appendChild($('pickerTemplate').content.cloneNode(true));
  const grid = host.querySelector('.grid');
  let kind = 'window';

  async function render() {
    const sources = (await liveShare.listSources()).filter((s) => s.kind === kind);
    grid.innerHTML = '';
    if (sources.length === 0) {
      grid.innerHTML = '<div class="empty">Nada para mostrar aqui.</div>';
      return;
    }
    for (const source of sources) grid.appendChild(sourceCard(source));
  }

  function sourceCard(source) {
    const card = document.createElement('button');
    card.className = 'card' + (state.selected?.id === source.id ? ' selected' : '');
    card.title = source.name;
    card.innerHTML = `<img class="thumb" alt=""><div class="name">${source.icon ? '<img alt="">' : ''}<span></span></div>`;
    card.querySelector('.thumb').src = source.thumbnail;
    if (source.icon) card.querySelector('.name img').src = source.icon;
    card.querySelector('.name span').textContent = source.name;
    card.addEventListener('click', () => {
      grid.querySelectorAll('.card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      onPick(source);
    });
    return card;
  }

  host.querySelectorAll('.tab[data-kind]').forEach((tab) => tab.addEventListener('click', () => {
    host.querySelectorAll('.tab[data-kind]').forEach((t) => t.classList.toggle('active', t === tab));
    kind = tab.dataset.kind;
    render();
  }));
  host.querySelector('[data-action="refresh"]').addEventListener('click', render);

  render();
  const timer = setInterval(render, 4000);
  return () => clearInterval(timer);
}
