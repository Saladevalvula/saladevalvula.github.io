/* Sala de Válvulas - custos retroativos do histórico */
(() => {
  'use strict';

  const costHistory = {};
  let wrapped = false;

  function money(v) {
    const n = Number(v || 0);
    return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function monthOf(value) {
    if (!value) return '';
    if (typeof value.toDate === 'function') value = value.toDate();
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return String(value).slice(0, 7);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  }

  function rowsFor(month, line) {
    return Object.values(costHistory).filter(r => {
      const sameLine = line === 'all' || String(r.line) === String(line);
      return sameLine && monthOf(r.timestamp || r.createdAt) === String(month || '');
    });
  }

  function allRows(line) {
    return Object.values(costHistory).filter(r => line === 'all' || String(r.line) === String(line));
  }

  function injectPanel(container) {
    if (!container || state?.mode !== 'dashboard') return;
    container.querySelector?.('#history-material-cost-panel')?.remove?.();

    const month = String(state?.cmms?.dashboardMonth || '');
    const line = String(state?.cmms?.dashboardLine || 'all');
    const monthly = rowsFor(month, line);
    const accumulated = allRows(line);

    const correlated = monthly.filter(r => (r.linkedMaterialCodes || []).length > 0);
    const priced = monthly.filter(r => Number(r.materialCostEstimated || 0) > 0);
    const pending = monthly.filter(r => r.materialCostStatus === 'pending_unit_cost');
    const partial = monthly.filter(r => r.materialCostStatus === 'partial');
    const monthlyCost = priced.reduce((s,r)=>s + Number(r.materialCostEstimated || 0), 0);
    const accumulatedCost = accumulated.reduce((s,r)=>s + Number(r.materialCostEstimated || 0), 0);

    const panel = document.createElement('div');
    panel.id = 'history-material-cost-panel';
    panel.className = 'report-panel';
    panel.innerHTML = `
      <div class="report-panel-title">
        <h3>Custos de materiais</h3>
        <span>estimativa retroativa baseada no catálogo disponível</span>
      </div>
      <div class="report-kpis">
        <div class="report-kpi good"><small>Custo estimado no mês</small><strong>${money(monthlyCost)}</strong><span>${priced.length} registro(s) com valor</span></div>
        <div class="report-kpi"><small>Intervenções correlacionadas</small><strong>${correlated.length}</strong><span>material vinculado pelo subconjunto</span></div>
        <div class="report-kpi"><small>Aguardando preço</small><strong>${pending.length}</strong><span>materiais já identificados</span></div>
        <div class="report-kpi"><small>Acumulado estimado</small><strong>${money(accumulatedCost)}</strong><span>${partial.length ? `${partial.length} parcial(is) no mês` : 'base disponível até agora'}</span></div>
      </div>
      <div class="cmms-definition-note"><strong>Importante:</strong> estes valores históricos são estimativas retroativas. Eles não substituem custo real SAP. Conforme novos valores unitários forem cadastrados, os registros pendentes poderão ser recalculados sem alterar a data original da manutenção.</div>`;

    const accumulatedHistory = container.querySelector?.('#cmms-history-accumulated');
    if (accumulatedHistory) accumulatedHistory.insertAdjacentElement('afterend', panel);
    else {
      const firstGrid = container.querySelector?.('.report-kpis');
      if (firstGrid) firstGrid.insertAdjacentElement('afterend', panel);
      else container.appendChild(panel);
    }
  }

  function wrapDashboard(attempt = 0) {
    if (wrapped) return;
    if (typeof window.renderDashboardView !== 'function') {
      if (attempt < 40) setTimeout(() => wrapDashboard(attempt + 1), 75);
      return;
    }
    const base = window.renderDashboardView;
    window.renderDashboardView = function(container) {
      const result = base.apply(this, arguments);
      injectPanel(container);
      return result;
    };
    wrapped = true;
    if (state?.mode === 'dashboard') injectPanel(document.getElementById('main-container'));
  }

  if (typeof db !== 'undefined' && typeof db.collectionGroup === 'function') {
    db.collectionGroup('history').onSnapshot(snap => {
      Object.keys(costHistory).forEach(k => delete costHistory[k]);
      snap.forEach(doc => {
        const d = doc.data() || {};
        if (!['corretiva','preventiva'].includes(String(d.type || '').toLowerCase())) return;
        const path = String(doc.ref.path || '');
        costHistory[path] = { ...d, historyPath: path };
      });
      if (state?.mode === 'dashboard') injectPanel(document.getElementById('main-container'));
    }, err => console.warn('history cost listener', err));
  }

  setTimeout(() => wrapDashboard(0), 0);
})();
