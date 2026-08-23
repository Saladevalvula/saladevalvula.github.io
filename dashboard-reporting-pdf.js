/* Exportação PDF do dashboard mensal baseada na tela já renderizada.
 * Carrega depois de dashboard-reporting.js e substitui apenas a exportação PDF.
 */
(() => {
  'use strict';

  function text(el, fallback = '-') {
    const v = el?.textContent?.trim();
    return v || fallback;
  }

  function rowsFromPanel(panel) {
    if (!panel) return [];
    return [...panel.querySelectorAll('.report-bar-row')].map(row => {
      const parts = row.querySelectorAll('.report-bar-label span, .report-bar-label strong');
      return [text(parts[0]), text(parts[1], '0')];
    });
  }

  function findPanel(titlePart) {
    return [...document.querySelectorAll('.report-panel')].find(p => text(p.querySelector('.report-panel-title h3'), '').toLowerCase().includes(titlePart.toLowerCase()));
  }

  function findFirstPanel(parts) {
    for (const part of parts) {
      const panel = findPanel(part);
      if (panel) return panel;
    }
    return null;
  }

  function addTitle(doc, title, period) {
    doc.setFontSize(18); doc.setTextColor(20); doc.text(title, 14, 15);
    doc.setFontSize(9); doc.setTextColor(90); doc.text(period, 14, 21);
  }

  function addKpis(doc, cards) {
    const width = 64;
    cards.slice(0, 8).forEach((card, i) => {
      const x = 14 + (i % 4) * 69;
      const y = 28 + Math.floor(i / 4) * 27;
      doc.setDrawColor(210); doc.roundedRect(x, y, width, 22, 2, 2);
      doc.setFontSize(7); doc.setTextColor(100); doc.text(text(card.querySelector('small')).toUpperCase(), x + 4, y + 7);
      doc.setFontSize(15); doc.setTextColor(20); doc.text(text(card.querySelector('strong')), x + 4, y + 17);
    });
  }

  window.exportDashboardPDF = function() {
    if (!window.jspdf?.jsPDF) return showToast('Exportação PDF indisponível neste navegador.', 'error');
    const root = document.querySelector('.report-dashboard');
    if (!root) return showToast('Abra o dashboard antes de exportar.', 'error');

    const period = text(root.querySelector('.report-period'));
    const month = root.querySelector('input[type="month"]')?.value || 'periodo';
    const lineValue = root.querySelector('.report-field select')?.value || 'all';
    const lineLabel = lineValue === 'all' ? 'Geral' : `L${lineValue}`;
    const doc = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

    addTitle(doc, 'Sala de Válvulas - Relatório de Manutenção', period);
    doc.setFontSize(7); doc.setTextColor(105);
    doc.text('Corretiva = atuação/troca de subconjunto durante produção. Preventiva = válvula executada no PCM.', 14, 25);
    addKpis(doc, [...root.querySelectorAll('.report-kpi')]);

    const comparison = [...(findPanel('Comparação com')?.querySelectorAll('.report-compare-row') || [])].map(r => {
      const name = text(r.querySelector('.name'));
      const nums = text(r.querySelector('.num'));
      const delta = text(r.querySelector('.report-delta'));
      return [name, nums, delta];
    });
    doc.setFontSize(11); doc.setTextColor(20); doc.text('Comparação mensal', 14, 88);
    doc.autoTable({ startY: 92, head: [['Indicador', 'Anterior → Selecionado', 'Variação']], body: comparison.length ? comparison : [['-', '-', '-']], theme: 'grid', styles: { fontSize: 8 }, headStyles: { fillColor: [45, 50, 58] } });

    doc.addPage();
    addTitle(doc, 'Análise técnica', period);
    const valveRows = rowsFromPanel(findFirstPanel(['Pareto · válvulas em produção', 'Pareto · válvulas']));
    doc.setFontSize(11); doc.setTextColor(20); doc.text('Pareto de válvulas com corretivas em produção', 14, 30);
    doc.autoTable({ startY: 34, head: [['Válvula', 'Atuações']], body: valveRows.length ? valveRows : [['Sem dados', '0']], theme: 'grid', tableWidth: 125, margin: { left: 14 }, styles: { fontSize: 8 }, headStyles: { fillColor: [45, 50, 58] } });

    const componentRows = rowsFromPanel(findFirstPanel(['Pareto · subconjuntos', 'Pareto · componentes']));
    doc.setFontSize(11); doc.text('Pareto de subconjuntos', 157, 30);
    doc.autoTable({ startY: 34, head: [['Subconjunto', 'Atuações']], body: componentRows.length ? componentRows : [['Sem dados', '0']], theme: 'grid', tableWidth: 125, margin: { left: 157 }, styles: { fontSize: 8 }, headStyles: { fillColor: [45, 50, 58] } });

    const recPanel = findPanel('Reincidências do mês');
    const recRows = [...(recPanel?.querySelectorAll('.report-recurrence') || [])].map(r => [text(r.querySelector('strong')), text(r.querySelector('b'))]);
    doc.setFontSize(11); doc.text('Reincidências', 14, 118);
    doc.autoTable({ startY: 122, head: [['Local / subconjunto', 'Ocorrências']], body: recRows.length ? recRows : [['Sem reincidências', '0']], theme: 'grid', tableWidth: 125, margin: { left: 14 }, styles: { fontSize: 8 }, headStyles: { fillColor: [45, 50, 58] } });

    const sapPanel = findPanel('Ordens SAP');
    const sapRows = [...(sapPanel?.querySelectorAll('.report-recurrence') || [])].map(r => [text(r.querySelector('strong')), text(r.querySelector('small'))]);
    doc.setFontSize(11); doc.text('Ordens SAP', 157, 118);
    doc.autoTable({ startY: 122, head: [['Ordem', 'Descrição']], body: sapRows.length ? sapRows : [['Sem ordens SAP', '-']], theme: 'grid', tableWidth: 125, margin: { left: 157 }, styles: { fontSize: 7 }, headStyles: { fillColor: [45, 50, 58] } });

    doc.addPage();
    addTitle(doc, 'Planejamento preventivo', period);
    const planRows = [...root.querySelectorAll('.report-plan-card')].map(card => {
      const strongs = card.querySelectorAll('strong');
      const line = text(strongs[0]);
      const range = text(card.querySelector('small'));
      const exec = text(card.querySelector('b'));
      const foot = [...card.querySelectorAll('.report-plan-foot span')].map(x => text(x)).join(' | ');
      return [line, range, exec, foot];
    });
    doc.autoTable({ startY: 28, head: [['Linha', 'Sequência', 'Executado', 'Status']], body: planRows.length ? planRows : [['-', 'Sem programação', '0/0', '-']], theme: 'grid', styles: { fontSize: 8 }, headStyles: { fillColor: [45, 50, 58] } });

    doc.save(`Relatorio_Manutencao_${month}_${lineLabel}.pdf`);
    showToast('Relatório PDF gerado.', 'success');
  };
})();
