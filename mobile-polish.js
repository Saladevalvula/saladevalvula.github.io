/* Sala de Válvulas - acabamento visual mobile */
(() => {
  'use strict';

  const STYLE_ID = 'cmms-mobile-polish-style';
  const cycleState = {};
  const dashboardHistory = {};
  const DASH_LINES = ['512', '513', '514'];
  let dashboardWrapped = false;
  let dashboardHistoryReady = false;

  function currentMonthKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function cycleCompleted(line) {
    const row = cycleState[String(line)];
    if (!row) return null;
    const raw = Number(row.lastCompletedValve ?? row.completedThrough ?? 0);
    if (!Number.isFinite(raw) || raw < 0) return null;
    const max = String(line) === '514' ? 72 : 175;
    return Math.min(max, raw);
  }

  function valveHistoryRecord(doc) {
    const path = String(doc?.ref?.path || '');
    const p = path.split('/');
    if (p.length !== 6 || p[0] !== 'lines' || p[2] !== 'valves' || p[4] !== 'history') return null;
    const line = String(p[1] || '');
    const valve = String(p[3] || '');
    if (!DASH_LINES.includes(line)) return null;
    const data = doc.data ? (doc.data() || {}) : {};
    return {
      ...data,
      line: String(data.line || line),
      valve: String(data.valve ?? valve),
      historyDocId: data.historyDocId || doc.id,
      historyPath: path
    };
  }

  function syncCanonicalHistoryToGlobalDB() {
    if (!dashboardHistoryReady || typeof globalDB === 'undefined') return;

    DASH_LINES.forEach(line => {
      if (!globalDB[line]) globalDB[line] = {};
      Object.values(globalDB[line]).forEach(v => { v.historico = []; });
    });

    Object.values(dashboardHistory).forEach(r => {
      const line = String(r.line || '');
      const valve = String(r.valve || '');
      if (!DASH_LINES.includes(line) || !valve) return;
      if (!globalDB[line]) globalDB[line] = {};
      if (!globalDB[line][valve]) {
        globalDB[line][valve] = {
          valveNumber: valve === 'GERAL' ? 0 : Number(valve),
          docId: valve
        };
      }
      const target = globalDB[line][valve];
      target.historico = target.historico || [];
      target.historico.push(r);
    });
  }

  function dashboardHistoryRows(line) {
    const selectedLine = String(line || 'all');
    return Object.values(dashboardHistory).filter(r => selectedLine === 'all' || String(r.line) === selectedLine);
  }

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .cmms-plan-fields{
        display:grid!important;
        grid-template-columns:minmax(0,1.35fr) minmax(0,.65fr)!important;
        gap:.75rem!important;
      }
      .cmms-plan-fields>div{min-width:0!important}
      #pl-month.cmms-month-field{
        display:block;
        width:100%!important;
        max-width:100%!important;
        min-width:0!important;
        box-sizing:border-box!important;
        font-size:16px!important;
        padding-left:12px!important;
        padding-right:38px!important;
        text-overflow:clip!important;
      }
      #pl-count.cmms-plan-number,
      #pl-start.cmms-plan-number{min-height:50px}
      #pl-preview.cmms-plan-preview{
        line-height:1.65;
        overflow-wrap:anywhere;
      }
      .cmms-plan-save{min-height:52px}

      .cmms-report-month-field{
        flex:1 1 200px!important;
        min-width:200px!important;
      }
      .cmms-report-month-input{
        display:block!important;
        width:100%!important;
        min-width:0!important;
        box-sizing:border-box!important;
        font-size:16px!important;
        padding-left:12px!important;
        padding-right:38px!important;
        text-overflow:clip!important;
      }
      #cmms-cycle-dashboard-kpi strong{color:#86efac!important}
      #cmms-history-accumulated{margin-top:12px}
      #cmms-history-accumulated .report-kpi{min-height:96px}
      #cmms-history-accumulated .report-kpi strong{font-size:1.55rem}

      @media(max-width:520px){
        .cmms-plan-fields{grid-template-columns:minmax(0,1fr)!important}
        #pl-month.cmms-month-field{
          font-size:16px!important;
          min-height:52px!important;
          padding-right:42px!important;
        }
        #pl-count.cmms-plan-number,
        #pl-start.cmms-plan-number{min-height:52px}
        #pl-preview.cmms-plan-preview{font-size:14px!important;padding:14px!important}
        .cmms-plan-save{min-height:54px;font-size:15px!important}

        .report-toolbar-controls{width:100%!important}
        .cmms-report-month-field{
          flex:1 1 190px!important;
          min-width:190px!important;
        }
        .cmms-report-month-input{
          min-height:52px!important;
          font-size:15px!important;
          padding-right:40px!important;
        }
      }

      @media(max-width:380px){
        .cmms-report-month-field{min-width:180px!important}
        .cmms-report-month-input{font-size:14px!important}
      }
    `;
    document.head.appendChild(style);
  }

  function polishPlanModal() {
    const month = document.getElementById('pl-month');
    if (!month) return;

    const firstGrid = month.closest('.grid');
    if (firstGrid) firstGrid.classList.add('cmms-plan-fields');

    month.classList.add('cmms-month-field');
    document.getElementById('pl-count')?.classList.add('cmms-plan-number');
    document.getElementById('pl-start')?.classList.add('cmms-plan-number');
    document.getElementById('pl-preview')?.classList.add('cmms-plan-preview');

    const saveButton = [...document.querySelectorAll('button')]
      .find(btn => String(btn.textContent || '').trim().toUpperCase() === 'SALVAR PROGRAMAÇÃO');
    saveButton?.classList.add('cmms-plan-save');
  }

  function polishRegisterTitle() {
    const root = document.getElementById('main-container');
    if (!root || state?.mode !== 'register' || state?.step !== 'line') return;
    const heading = [...root.querySelectorAll('h2')]
      .find(el => String(el.textContent || '').trim().toLowerCase() === 'painel geral');
    if (heading) heading.textContent = 'Dash Sala de Válvulas';
  }

  function renderAccumulatedHistory(container) {
    container.querySelector('#cmms-history-accumulated')?.remove();
    if (!dashboardHistoryReady) return;

    const selectedLine = String(state?.cmms?.dashboardLine || 'all');
    const rows = dashboardHistoryRows(selectedLine);
    const corrective = rows.filter(r => r.type === 'corretiva').length;
    const preventive = rows.filter(r => r.type === 'preventiva').length;
    const sonda = rows.filter(r => r.type === 'sonda_event').length;
    const scope = selectedLine === 'all' ? 'Todas as linhas' : `L${selectedLine}`;

    const panel = document.createElement('div');
    panel.id = 'cmms-history-accumulated';
    panel.className = 'report-panel';
    panel.innerHTML = `
      <div class="report-panel-title">
        <h3>Acumulado do histórico</h3>
        <span>${scope} · todas as datas</span>
      </div>
      <div class="report-kpis">
        <div class="report-kpi"><small>Intervenções acumuladas</small><strong>${rows.length}</strong><span>histórico completo</span></div>
        <div class="report-kpi"><small>Corretivas acumuladas</small><strong>${corrective}</strong><span>histórico completo</span></div>
        <div class="report-kpi good"><small>Preventivas acumuladas</small><strong>${preventive}</strong><span>registros com data</span></div>
        <div class="report-kpi"><small>Eventos de sonda</small><strong>${sonda}</strong><span>histórico completo</span></div>
      </div>`;

    const monthlyGrid = container.querySelector('.report-kpis');
    if (monthlyGrid) monthlyGrid.insertAdjacentElement('afterend', panel);
  }

  function polishDashboard(container) {
    if (!container) return;

    const monthInput = container.querySelector('.report-toolbar input[type="month"]');
    if (monthInput) {
      monthInput.classList.add('cmms-report-month-input');
      monthInput.closest('.report-field')?.classList.add('cmms-report-month-field');
    }

    const kpis = [...container.querySelectorAll('.report-kpi')];
    kpis.forEach(card => {
      const label = String(card.querySelector('small')?.textContent || '').trim().toLowerCase();
      if (label === 'intervenções') card.querySelector('small').textContent = 'Intervenções no mês';
      if (label === 'corretivas') card.querySelector('small').textContent = 'Corretivas no mês';
      if (label === 'preventivas') card.querySelector('small').textContent = 'Preventivas no mês';
    });

    renderAccumulatedHistory(container);
    container.querySelector('#cmms-cycle-dashboard-kpi')?.remove();

    const selectedMonth = String(state?.cmms?.dashboardMonth || currentMonthKey());
    const selectedLine = String(state?.cmms?.dashboardLine || 'all');
    if (selectedMonth !== currentMonthKey() || !DASH_LINES.includes(selectedLine)) return;

    const completed = cycleCompleted(selectedLine);
    if (completed == null) return;
    const max = selectedLine === '514' ? 72 : 175;
    const next = completed >= max ? 1 : completed + 1;

    const card = document.createElement('div');
    card.id = 'cmms-cycle-dashboard-kpi';
    card.className = 'report-kpi good';
    card.innerHTML = `<small>Ciclo preventivo</small><strong>${completed}</strong><span>de ${max} · concluído até V${completed} · próxima V${next}</span>`;

    const grid = container.querySelector('.report-kpis');
    if (!grid) return;
    const preventiveCard = [...grid.querySelectorAll('.report-kpi')]
      .find(k => String(k.querySelector('small')?.textContent || '').trim().toLowerCase() === 'preventivas no mês');
    if (preventiveCard) preventiveCard.insertAdjacentElement('afterend', card);
    else grid.appendChild(card);
  }

  function wrapDashboardWhenReady(attempt = 0) {
    if (dashboardWrapped) return;
    if (typeof window.renderDashboardView !== 'function') {
      if (attempt < 30) setTimeout(() => wrapDashboardWhenReady(attempt + 1), 50);
      return;
    }

    const baseRenderDashboardView = window.renderDashboardView;
    window.renderDashboardView = function(container) {
      syncCanonicalHistoryToGlobalDB();
      const result = baseRenderDashboardView.apply(this, arguments);
      polishDashboard(container);
      return result;
    };
    dashboardWrapped = true;

    if (state?.mode === 'dashboard') {
      const c = document.getElementById('main-container');
      if (c) {
        syncCanonicalHistoryToGlobalDB();
        polishDashboard(c);
      }
    }
  }

  installStyles();

  const baseOpenPlanModal = window.openPlanModal;
  if (typeof baseOpenPlanModal === 'function') {
    window.openPlanModal = function(...args) {
      const result = baseOpenPlanModal.apply(this, args);
      requestAnimationFrame(polishPlanModal);
      setTimeout(polishPlanModal, 0);
      return result;
    };
  }

  const mainContainer = document.getElementById('main-container');
  if (mainContainer && typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver(polishRegisterTitle);
    observer.observe(mainContainer, { childList: true, subtree: true });
  }

  if (typeof db !== 'undefined') {
    db.collection('maintenance_cycle_state').onSnapshot(snap => {
      Object.keys(cycleState).forEach(k => delete cycleState[k]);
      snap.forEach(doc => { cycleState[doc.id] = { id: doc.id, ...doc.data() }; });
      if (state?.mode === 'dashboard') {
        const c = document.getElementById('main-container');
        if (c) polishDashboard(c);
      }
    }, err => console.warn('dashboard cycle listener', err));

    if (typeof db.collectionGroup === 'function') {
      db.collectionGroup('history').onSnapshot(snap => {
        Object.keys(dashboardHistory).forEach(k => delete dashboardHistory[k]);
        snap.forEach(doc => {
          const record = valveHistoryRecord(doc);
          if (record) dashboardHistory[record.historyPath] = record;
        });
        dashboardHistoryReady = true;
        syncCanonicalHistoryToGlobalDB();
        if (state?.mode === 'dashboard' && typeof render === 'function') render(false);
      }, err => console.warn('dashboard canonical history listener', err));
    }
  }

  setTimeout(polishRegisterTitle, 0);
  setTimeout(() => wrapDashboardWhenReady(0), 0);
})();
