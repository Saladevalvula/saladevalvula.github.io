/* Sala de Válvulas - acabamento visual mobile */
(() => {
  'use strict';

  const STYLE_ID = 'cmms-mobile-polish-style';

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
})();
