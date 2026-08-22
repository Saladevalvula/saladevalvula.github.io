/* Sala de Válvulas - estado do ciclo preventivo
 * Mostra onde cada enchedora parou sem transformar uma informação de sequência
 * em intervenções históricas artificiais.
 */
(() => {
  'use strict';
  if (typeof renderOrdersView !== 'function' || typeof db === 'undefined') return;

  const cycleState = {};
  const baseRenderOrdersView = renderOrdersView;

  function esc(v) {
    return String(v ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  function injectCycleState(container) {
    const old = document.getElementById('preventive-cycle-state-card');
    if (old) old.remove();
    const rows = ['512', '513', '514'].map(line => {
      const s = cycleState[line];
      if (!s) return `<div class="cmms-order-card"><strong>L${line}</strong><div class="text-xs text-gray-500 mt-2">Sequência ainda não informada.</div></div>`;
      const last = Number(s.lastCompletedValve || s.completedThrough || 0);
      const next = Number(s.nextValve || (last + 1));
      return `<div class="cmms-order-card"><div class="flex justify-between items-start gap-2"><div><strong>L${line}</strong><div class="text-xs text-gray-500 mt-1">Ciclo preventivo</div></div><span class="cmms-badge ok">até V${last}</span></div><div class="font-mono text-sm text-primary mt-3">Próxima: V${next}</div>${s.note?`<div class="text-[10px] text-gray-600 mt-2">${esc(s.note)}</div>`:''}</div>`;
    }).join('');

    const block = document.createElement('div');
    block.id = 'preventive-cycle-state-card';
    block.className = 'card-industrial p-4';
    block.innerHTML = `<div class="cmms-section-title">Posição atual do ciclo</div><div class="grid grid-cols-1 md:grid-cols-3 gap-3">${rows}</div>`;

    const root = container.querySelector('.space-y-4') || container.firstElementChild || container;
    const firstCard = root.querySelector('.cmms-grid-auto, .card-industrial');
    if (firstCard) firstCard.insertAdjacentElement('afterend', block);
    else root.appendChild(block);
    if (window.lucide) lucide.createIcons();
  }

  renderOrdersView = function(container) {
    baseRenderOrdersView(container);
    injectCycleState(container);
  };

  db.collection('maintenance_cycle_state').onSnapshot(snap => {
    Object.keys(cycleState).forEach(k => delete cycleState[k]);
    snap.forEach(doc => { cycleState[doc.id] = { id: doc.id, ...doc.data() }; });
    if (state.mode === 'orders') render(false);
  }, err => console.warn('maintenance_cycle_state listener', err));
})();
