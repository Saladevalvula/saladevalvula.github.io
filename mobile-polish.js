/* Sala de Válvulas - acabamento visual mobile e terminologia operacional */
(() => {
  'use strict';

  const STYLE_ID = 'cmms-mobile-polish-style';
  const REGISTER_TITLE = 'Plano de Manutenção Sala de Válvulas';
  const cycleState = {};
  const dashboardHistory = {};
  const DASH_LINES = ['512', '513', '514'];
  let dashboardWrapped = false;
  let dashboardHistoryReady = false;

  function setTextIfChanged(el, value) {
    if (!el) return false;
    const next = String(value);
    if (String(el.textContent || '') === next) return false;
    el.textContent = next;
    return true;
  }

  function currentMonthKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function monthOf(value) {
    if (!value) return '';
    if (typeof value.toDate === 'function') value = value.toDate();
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return String(value).slice(0, 7);
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

  function dashboardMonthRows(month, line) {
    return dashboardHistoryRows(line).filter(r => monthOf(r.timestamp) === String(month || ''));
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
      .cmms-stat-label-long{font-size:.68rem!important;line-height:1.15!important}
      .cmms-definition-note{
        margin:10px 0 12px;
        padding:9px 11px;
        border:1px solid #243247;
        border-radius:11px;
        background:#0a1019;
        color:#8190a5;
        font-size:10px;
        line-height:1.45;
      }
      .cmms-definition-note strong{color:#e8b800}
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
        .cmms-stat-label-long{font-size:.62rem!important}
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

    const firstGrid = month.closest?.('.grid');
    if (firstGrid) firstGrid.classList.add('cmms-plan-fields');

    month.classList?.add('cmms-month-field');
    document.getElementById('pl-count')?.classList?.add('cmms-plan-number');
    document.getElementById('pl-start')?.classList?.add('cmms-plan-number');
    document.getElementById('pl-preview')?.classList?.add('cmms-plan-preview');

    const saveButton = [...(document.querySelectorAll?.('button') || [])]
      .find(btn => String(btn.textContent || '').trim().toUpperCase() === 'SALVAR PROGRAMAÇÃO');
    saveButton?.classList?.add('cmms-plan-save');
  }

  function polishRegisterTerminology() {
    const root = document.getElementById('main-container');
    if (!root) return;

    if (state?.mode === 'register' && state?.step === 'line') {
      const acceptedTitles = ['painel geral', 'dash sala de válvulas', REGISTER_TITLE.toLowerCase()];
      const heading = [...(root.querySelectorAll?.('h2') || [])]
        .find(el => acceptedTitles.includes(String(el.textContent || '').trim().toLowerCase()));
      setTextIfChanged(heading, REGISTER_TITLE);

      [...(root.querySelectorAll?.('.card-industrial span') || [])].forEach(el => {
        const label = String(el.textContent || '').trim().toLowerCase();
        if (label === 'pendentes') {
          setTextIfChanged(el, 'Restantes no ciclo');
          el.classList?.add('cmms-stat-label-long');
        } else if (label === 'preventivas') {
          setTextIfChanged(el, 'Ciclo preventivo');
          el.classList?.add('cmms-stat-label-long');
        } else if (label === 'corretivas') {
          setTextIfChanged(el, 'Corretivas em produção');
          el.classList?.add('cmms-stat-label-long');
        }
      });
    }

    if (state?.mode === 'register' || state?.mode === 'history') {
      [...(root.querySelectorAll?.('option[value="corretiva"]') || [])].forEach(el => {
        setTextIfChanged(el, 'Corretiva em produção');
      });
      [...(root.querySelectorAll?.('button') || [])].forEach(el => {
        if (String(el.textContent || '').trim() === 'Corretiva') setTextIfChanged(el, 'Corretiva em produção');
      });
    }

    if (state?.mode === 'history') {
      [...(root.querySelectorAll?.('.cmms-kpi small') || [])].forEach(el => {
        if (String(el.textContent || '').trim().toLowerCase() === 'corretivas') {
          setTextIfChanged(el, 'Corretivas em produção');
        }
      });
    }
  }

  function renderAccumulatedHistory(container) {
    container.querySelector?.('#cmms-history-accumulated')?.remove?.();
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
        <div class="report-kpi"><small>Corretivas em produção</small><strong>${corrective}</strong><span>atuações em subconjuntos</span></div>
        <div class="report-kpi good"><small>Preventivas acumuladas</small><strong>${preventive}</strong><span>registros com data</span></div>
        <div class="report-kpi"><small>Eventos de sonda</small><strong>${sonda}</strong><span>histórico completo</span></div>
      </div>`;

    const monthlyGrid = container.querySelector?.('.report-kpis');
    if (monthlyGrid) monthlyGrid.insertAdjacentElement?.('afterend', panel);
  }

  function renderDefinitionNote(container) {
    container.querySelector?.('#cmms-maintenance-definition')?.remove?.();
    const grid = container.querySelector?.('.report-kpis');
    if (!grid) return;
    const note = document.createElement('div');
    note.id = 'cmms-maintenance-definition';
    note.className = 'cmms-definition-note';
    note.innerHTML = '<strong>Regra de contagem:</strong> corretiva = 1 atuação/troca de subconjunto com a linha em produção. Preventiva = válvula executada no PCM.';
    grid.insertAdjacentElement?.('beforebegin', note);
  }

  function polishDashboard(container) {
    if (!container) return;

    const monthInput = container.querySelector?.('.report-toolbar input[type="month"]');
    if (monthInput) {
      monthInput.classList?.add('cmms-report-month-input');
      monthInput.closest?.('.report-field')?.classList?.add('cmms-report-month-field');
    }

    const kpis = [...(container.querySelectorAll?.('.report-kpi') || [])];
    let interventionsCard = null;
    let preventiveCard = null;
    kpis.forEach(card => {
      const labelEl = card.querySelector?.('small');
      const label = String(labelEl?.textContent || '').trim().toLowerCase();
      if (label === 'intervenções' || label === 'intervenções no mês') {
        setTextIfChanged(labelEl, 'Intervenções no mês');
        interventionsCard = card;
      }
      if (label === 'corretivas' || label === 'corretivas no mês' || label === 'corretivas em produção') {
        setTextIfChanged(labelEl, 'Corretivas em produção');
      }
      if (label === 'preventivas' || label === 'preventivas no mês') {
        setTextIfChanged(labelEl, 'Preventivas no mês');
        preventiveCard = card;
      }
    });

    const selectedMonth = String(state?.cmms?.dashboardMonth || currentMonthKey());
    const selectedLine = String(state?.cmms?.dashboardLine || 'all');

    if (dashboardHistoryReady && interventionsCard) {
      const rows = dashboardMonthRows(selectedMonth, selectedLine);
      const corr = rows.filter(r => r.type === 'corretiva').length;
      const prev = rows.filter(r => r.type === 'preventiva').length;
      const sonda = rows.filter(r => r.type === 'sonda_event').length;
      const falhas = rows.filter(r => r.type === 'falha_geral').length;
      const other = Math.max(0, rows.length - corr - prev - sonda - falhas);
      const parts = [];
      if (corr) parts.push(`${corr} corretivas em produção`);
      if (prev) parts.push(`${prev} preventivas`);
      if (sonda) parts.push(`${sonda} eventos de sonda`);
      if (falhas) parts.push(`${falhas} falhas enchedora`);
      if (other) parts.push(`${other} outros`);
      const sub = interventionsCard.querySelector?.('span');
      if (sub) setTextIfChanged(sub, parts.length ? parts.join(' + ') : 'sem intervenções no período');
    }

    [...(container.querySelectorAll?.('.report-compare-row .name') || [])].forEach(el => {
      if (String(el.textContent || '').trim().toLowerCase() === 'corretivas') {
        setTextIfChanged(el, 'Corretivas em produção');
      }
    });

    [...(container.querySelectorAll?.('.report-panel-title h3') || [])].forEach(title => {
      const current = String(title.textContent || '').trim().toLowerCase();
      const subtitle = title.parentElement?.querySelector?.('span');
      if (current.startsWith('pareto · válvulas')) {
        setTextIfChanged(title, 'Pareto · válvulas em produção');
        if (subtitle) setTextIfChanged(subtitle, 'atuações corretivas do período');
      } else if (current.startsWith('pareto · componentes') || current.startsWith('pareto · subconjuntos')) {
        setTextIfChanged(title, 'Pareto · subconjuntos');
        if (subtitle) setTextIfChanged(subtitle, 'trocas/atuações em produção');
      }
    });

    renderDefinitionNote(container);
    renderAccumulatedHistory(container);
    container.querySelector?.('#cmms-cycle-dashboard-kpi')?.remove?.();

    if (selectedMonth !== currentMonthKey() || !DASH_LINES.includes(selectedLine)) return;

    const completed = cycleCompleted(selectedLine);
    if (completed == null) return;
    const max = selectedLine === '514' ? 72 : 175;
    const next = completed >= max ? 1 : completed + 1;

    const card = document.createElement('div');
    card.id = 'cmms-cycle-dashboard-kpi';
    card.className = 'report-kpi good';
    card.innerHTML = `<small>Ciclo preventivo</small><strong>${completed}</strong><span>de ${max} · concluído até V${completed} · próxima V${next}</span>`;

    const grid = container.querySelector?.('.report-kpis');
    if (!grid) return;
    if (!preventiveCard) {
      preventiveCard = [...(grid.querySelectorAll?.('.report-kpi') || [])]
        .find(k => String(k.querySelector?.('small')?.textContent || '').trim().toLowerCase() === 'preventivas no mês');
    }
    if (preventiveCard) preventiveCard.insertAdjacentElement?.('afterend', card);
    else grid.appendChild?.(card);
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
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(polishPlanModal);
      setTimeout(polishPlanModal, 0);
      return result;
    };
  }

  const mainContainer = document.getElementById('main-container');
  if (mainContainer && typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver(polishRegisterTerminology);
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

  setTimeout(polishRegisterTerminology, 0);
  setTimeout(() => wrapDashboardWhenReady(0), 0);
})();
