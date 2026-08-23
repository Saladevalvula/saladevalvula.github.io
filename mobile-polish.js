/* Sala de Válvulas - acabamento visual mobile */
(() => {
  'use strict';

  const STYLE_ID = 'cmms-mobile-polish-style';
  const cycleState = {};
  let dashboardWrapped = false;

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

  function polishDashboard(container) {
    if (!container) return;

    const monthInput = container.querySelector('.report-toolbar input[type="month"]');
    if (monthInput) {
      monthInput.classList.add('cmms-report-month-input');
      monthInput.closest('.report-field')?.classList.add('cmms-report-month-field');
    }

    const kpis = [...container.querySelectorAll('.report-kpi')];
    const preventiveCard = kpis.find(card => String(card.querySelector('small')?.textContent || '').trim().toLowerCase() === 'preventivas');
    if (preventiveCard) preventiveCard.querySelector('small').textContent = 'Preventivas no mês';

    container.querySelector('#cmms-cycle-dashboard-kpi')?.remove();

    const selectedMonth = String(state?.cmms?.dashboardMonth || currentMonthKey());
    const selectedLine = String(state?.cmms?.dashboardLine || 'all');
    if (selectedMonth !== currentMonthKey() || !['512', '513', '514'].includes(selectedLine)) return;

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
      const result = baseRenderDashboardView.apply(this, arguments);
      polishDashboard(container);
      return result;
    };
    dashboardWrapped = true;

    if (state?.mode === 'dashboard') {
      const c = document.getElementById('main-container');
      if (c) polishDashboard(c);
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
  }

  setTimeout(polishRegisterTitle, 0);
  setTimeout(() => wrapDashboardWhenReady(0), 0);
})();
