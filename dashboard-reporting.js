/* Sala de Válvulas - Dashboard mensal e relatórios de apresentação
 * Complemento da camada CMMS V2. Mantém os dados no Firebase como fonte única
 * e transforma o painel em uma visão histórica por mês/linha, pronta para reunião.
 */
(() => {
  'use strict';

  const LINES = ['512', '513', '514'];
  const reportDB = { sap: {}, plans: {}, workOrders: {} };

  state.cmms = Object.assign({
    dashboardMonth: currentMonthKey(),
    dashboardLine: 'all',
    presentationMode: false
  }, state.cmms || {});

  function currentMonthKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function previousMonthKey(key) {
    const [y, m] = String(key || currentMonthKey()).split('-').map(Number);
    const d = new Date(y, m - 2, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function monthLabel(key) {
    const [y, m] = String(key || currentMonthKey()).split('-').map(Number);
    if (!y || !m) return key || '-';
    const label = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  function esc(v) {
    return String(v ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  function dateOf(v) {
    if (!v) return null;
    if (typeof v.toDate === 'function') return v.toDate();
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function monthOf(v) {
    const d = dateOf(v);
    if (!d) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function lineMatch(value, line) {
    return line === 'all' || String(value || '') === String(line);
  }

  function allHistory() {
    const map = new Map();
    LINES.forEach(line => {
      Object.values(globalDB[line] || {}).forEach(valve => {
        (valve.historico || []).forEach(h => {
          const v = String(h.valve ?? valve.valveNumber ?? valve.docId ?? '');
          const id = h.historyDocId || h.id || `${h.timestamp || ''}-${h.subset || ''}-${h.description || ''}`;
          const key = `${line}/${v}/${id}`;
          map.set(key, { ...h, line: String(h.line || line), valve: v });
        });
      });
    });
    return [...map.values()];
  }

  function historyFor(month, line) {
    return allHistory().filter(h => monthOf(h.timestamp) === month && lineMatch(h.line, line));
  }

  function sapFor(month, line) {
    return Object.values(reportDB.sap).filter(o => String(o.month || '') === month && lineMatch(o.line, line));
  }

  function plansFor(month, line) {
    return Object.values(reportDB.plans).filter(p => String(p.month || '') === month && lineMatch(p.line, line));
  }

  function workOrdersCreatedFor(month, line) {
    return Object.values(reportDB.workOrders).filter(w => monthOf(w.createdAt) === month && lineMatch(w.linha, line));
  }

  function workOrdersCompletedFor(month, line) {
    return Object.values(reportDB.workOrders).filter(w => monthOf(w.completedAt) === month && lineMatch(w.linha, line));
  }

  function planProgress(plans) {
    let planned = 0;
    let done = 0;
    plans.forEach(p => {
      const valves = new Set((p.valves || []).map(Number));
      const completed = new Set((p.completedValves || []).map(Number));
      planned += valves.size;
      completed.forEach(v => { if (valves.has(v)) done += 1; });
    });
    return { planned, done, pct: planned ? Math.round((done / planned) * 100) : 0 };
  }

  function metricSet(month, line) {
    const hist = historyFor(month, line);
    const corr = hist.filter(h => h.type === 'corretiva');
    const prev = hist.filter(h => h.type === 'preventiva');
    const falhas = hist.filter(h => h.type === 'falha_geral');
    const sonda = hist.filter(h => h.type === 'sonda_event' || h.subset === 'SONDA');
    const sap = sapFor(month, line);
    const plans = plansFor(month, line);
    const plan = planProgress(plans);
    const osCreated = workOrdersCreatedFor(month, line);
    const osCompleted = workOrdersCompletedFor(month, line);
    const recurrence = recurrenceGroups(corr);
    return { hist, corr, prev, falhas, sonda, sap, plans, plan, osCreated, osCompleted, recurrence };
  }

  function pareto(items, keyFn, limit = 8) {
    const counts = {};
    items.forEach(item => {
      const key = keyFn(item) || '-';
      counts[key] = (counts[key] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit);
  }

  function recurrenceGroups(correctives) {
    const groups = {};
    correctives.forEach(h => {
      const key = `L${h.line}/V${h.valve} · ${h.subset || 'Geral'}`;
      (groups[key] ||= []).push(h);
    });
    return Object.entries(groups).filter(([, rows]) => rows.length >= 3).sort((a, b) => b[1].length - a[1].length);
  }

  function mtbfDays(correctives) {
    const byValve = {};
    correctives.filter(h => h.valve !== 'GERAL').forEach(h => {
      const t = dateOf(h.timestamp)?.getTime();
      if (Number.isFinite(t)) (byValve[`${h.line}/${h.valve}`] ||= []).push(t);
    });
    const gaps = [];
    Object.values(byValve).forEach(arr => {
      arr.sort((a, b) => a - b);
      for (let i = 1; i < arr.length; i += 1) gaps.push((arr[i] - arr[i - 1]) / 86400000);
    });
    return gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
  }

  function mttrMinutes(rows) {
    const vals = rows.map(w => {
      const a = dateOf(w.startedAt || w.createdAt);
      const b = dateOf(w.completedAt);
      return a && b ? (b - a) / 60000 : NaN;
    }).filter(v => Number.isFinite(v) && v >= 0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }

  function variation(current, previous, lowerIsBetter = false) {
    if (!previous && !current) return { text: 'sem variação', cls: 'neutral' };
    if (!previous) return { text: 'novo no período', cls: 'neutral' };
    const pct = ((current - previous) / previous) * 100;
    const arrow = pct > 0 ? '↑' : pct < 0 ? '↓' : '→';
    const improved = lowerIsBetter ? pct < 0 : pct > 0;
    const worsened = lowerIsBetter ? pct > 0 : pct < 0;
    return {
      text: `${arrow} ${Math.abs(pct).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`,
      cls: improved ? 'good' : worsened ? 'bad' : 'neutral'
    };
  }

  function pointsVariation(current, previous) {
    const delta = current - previous;
    if (!delta) return { text: '→ 0 p.p.', cls: 'neutral' };
    return { text: `${delta > 0 ? '↑' : '↓'} ${Math.abs(delta)} p.p.`, cls: delta > 0 ? 'good' : 'bad' };
  }

  function linePlanCards(plans, selectedLine) {
    const lines = selectedLine === 'all' ? LINES : [selectedLine];
    return lines.map(line => {
      const p = plans.find(x => String(x.line) === line);
      if (!p) return `<div class="report-plan-card"><div><strong>L${line}</strong><small>Sem programação</small></div><span class="report-plan-empty">-</span></div>`;
      const valves = (p.valves || []).map(Number);
      const completed = new Set((p.completedValves || []).map(Number));
      const done = valves.filter(v => completed.has(v)).length;
      const pct = valves.length ? Math.round((done / valves.length) * 100) : 0;
      const range = valves.length ? `V${valves[0]} → V${valves[valves.length - 1]}` : '-';
      return `<div class="report-plan-card"><div class="report-plan-head"><div><strong>L${line}</strong><small>${esc(range)}</small></div><b>${done}/${valves.length}</b></div><div class="report-progress"><span style="width:${pct}%"></span></div><div class="report-plan-foot"><span>${pct}% executado</span><span>${esc(p.status || 'planejado')}</span></div></div>`;
    }).join('');
  }

  function barRows(rows, empty = 'Sem dados suficientes.') {
    if (!rows.length) return `<div class="report-empty">${esc(empty)}</div>`;
    const max = rows[0][1] || 1;
    return rows.map(([name, value]) => `<div class="report-bar-row"><div class="report-bar-label"><span>${esc(name)}</span><strong>${value}</strong></div><div class="report-bar"><span style="width:${Math.max(3, Math.round((value / max) * 100))}%"></span></div></div>`).join('');
  }

  function kpi(label, value, sub = '', tone = '') {
    return `<div class="report-kpi ${tone}"><small>${esc(label)}</small><strong>${esc(value)}</strong>${sub ? `<span>${sub}</span>` : ''}</div>`;
  }

  function formatMttr(v) {
    if (v == null) return '-';
    return v < 60 ? `${Math.round(v)} min` : `${(v / 60).toFixed(1)} h`;
  }

  function injectStyles() {
    if (document.getElementById('dashboard-reporting-style')) return;
    const style = document.createElement('style');
    style.id = 'dashboard-reporting-style';
    style.textContent = `
      .report-toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:end;justify-content:space-between;padding:14px;border:1px solid #1d293a;border-radius:16px;background:linear-gradient(145deg,#0d141f,#090e16)}
      .report-toolbar-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:end}.report-field{display:flex;flex-direction:column;gap:5px;min-width:145px}.report-field label{font-size:10px;text-transform:uppercase;letter-spacing:.09em;color:#718096;font-weight:800}.report-field input,.report-field select{background:#080d14;border:1px solid #2a374b;border-radius:10px;padding:10px 11px;color:#e5e7eb;min-height:42px}
      .report-actions{display:flex;flex-wrap:wrap;gap:8px}.report-action{min-height:42px;padding:0 13px;border:1px solid #2a374b;border-radius:10px;background:#101824;color:#cbd5e1;font-size:11px;font-weight:800;display:inline-flex;align-items:center;gap:7px}.report-action.primary{background:#e8b800;border-color:#e8b800;color:#080b10}
      .report-title-row{display:flex;flex-wrap:wrap;align-items:end;justify-content:space-between;gap:12px}.report-period{font-family:'JetBrains Mono',monospace;color:#e8b800;font-size:.85rem}.report-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px}.report-kpi{background:linear-gradient(150deg,#0e1520,#090e16);border:1px solid #1c2a3e;border-radius:15px;padding:15px;min-height:112px}.report-kpi small{display:block;color:#738198;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em}.report-kpi strong{display:block;font-family:'JetBrains Mono',monospace;font-size:1.75rem;margin-top:6px;color:#f3f4f6}.report-kpi span{display:block;margin-top:5px;font-size:10px;color:#7f8da3}.report-kpi.good strong{color:#86efac}.report-kpi.warn strong{color:#fde047}.report-kpi.bad strong{color:#fca5a5}
      .report-grid-2{display:grid;grid-template-columns:1fr;gap:12px}.report-panel{background:#0b111a;border:1px solid #1d293a;border-radius:15px;padding:15px;min-width:0}.report-panel-title{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:13px}.report-panel-title h3{font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.09em;color:#aab5c5}.report-panel-title span{font-size:10px;color:#68778c}
      .report-bar-row{margin-bottom:11px}.report-bar-label{display:flex;justify-content:space-between;gap:10px;font-size:11px;margin-bottom:5px}.report-bar-label span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c4cedb}.report-bar{height:8px;background:#182334;border-radius:999px;overflow:hidden}.report-bar span{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#d4a900,#f2c800)}.report-empty{padding:20px;text-align:center;color:#66758a;font-size:12px;border:1px dashed #253247;border-radius:12px}
      .report-plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}.report-plan-card{background:#0a1019;border:1px solid #202d40;border-radius:13px;padding:13px}.report-plan-head{display:flex;justify-content:space-between;gap:8px}.report-plan-head strong{font-size:15px}.report-plan-head small{display:block;color:#7d8ba0;font-family:'JetBrains Mono',monospace;margin-top:3px}.report-plan-head b{font-family:'JetBrains Mono',monospace;color:#e8b800}.report-progress{height:8px;background:#182334;border-radius:999px;overflow:hidden;margin-top:12px}.report-progress span{display:block;height:100%;background:#e8b800;border-radius:999px}.report-plan-foot{display:flex;justify-content:space-between;gap:8px;margin-top:7px;font-size:9px;text-transform:uppercase;color:#718096}.report-plan-empty{font-family:'JetBrains Mono',monospace;color:#526074}
      .report-compare{display:grid;grid-template-columns:1fr;gap:8px}.report-compare-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;gap:12px;align-items:center;padding:11px 0;border-bottom:1px solid #182334}.report-compare-row:last-child{border-bottom:0}.report-compare-row .name{font-size:12px;color:#cbd5e1}.report-compare-row .num{font-family:'JetBrains Mono',monospace;font-size:12px}.report-delta{font-size:10px;font-weight:900;padding:4px 7px;border-radius:999px;border:1px solid #27354a}.report-delta.good{color:#86efac;border-color:rgba(34,197,94,.35);background:rgba(34,197,94,.06)}.report-delta.bad{color:#fca5a5;border-color:rgba(239,68,68,.35);background:rgba(239,68,68,.06)}.report-delta.neutral{color:#94a3b8}
      .report-recurrence{display:flex;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid #182334}.report-recurrence:last-child{border-bottom:0}.report-recurrence b{font-family:'JetBrains Mono',monospace;color:#fca5a5}.report-recurrence div{min-width:0}.report-recurrence strong{display:block;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.report-recurrence small{color:#6f7e93}
      body.cmms-presentation{padding-bottom:20px;background:#05080d}body.cmms-presentation header,body.cmms-presentation #cmms-bottom-nav{display:none!important}body.cmms-presentation #main-container{max-width:1480px!important;padding-top:22px!important}.cmms-presentation .report-toolbar-controls{display:none}.cmms-presentation .report-action.pdf{display:none}.cmms-presentation .report-kpi{min-height:135px}.cmms-presentation .report-kpi strong{font-size:2.25rem}.cmms-presentation .report-panel{padding:20px}.cmms-presentation .report-title-row h2{font-size:2rem}.cmms-presentation .report-period{font-size:1rem}
      @media(min-width:850px){.report-grid-2{grid-template-columns:1fr 1fr}.report-compare{gap:0}.report-toolbar{padding:16px}.report-kpi strong{font-size:2rem}}
      @media print{header,#cmms-bottom-nav,.report-toolbar{display:none!important}body{background:#fff!important;color:#111!important;padding:0!important}.report-panel,.report-kpi{break-inside:avoid}}
    `;
    document.head.appendChild(style);
  }

  function subscribe() {
    db.collection('sap_orders').onSnapshot(snap => {
      reportDB.sap = {};
      snap.forEach(d => { reportDB.sap[d.id] = { id: d.id, ...d.data() }; });
      if (state.mode === 'dashboard') render(false);
    });
    db.collection('maintenance_plans').onSnapshot(snap => {
      reportDB.plans = {};
      snap.forEach(d => { reportDB.plans[d.id] = { id: d.id, ...d.data() }; });
      if (state.mode === 'dashboard') render(false);
    });
    db.collection('work_orders').onSnapshot(snap => {
      reportDB.workOrders = {};
      snap.forEach(d => { reportDB.workOrders[d.id] = { id: d.id, ...d.data() }; });
      if (state.mode === 'dashboard') render(false);
    });
  }

  window.setDashboardMonth = function(value) {
    if (!/^\d{4}-\d{2}$/.test(value || '')) return;
    state.cmms.dashboardMonth = value;
    render(false);
  };

  window.setDashboardLine = function(value) {
    state.cmms.dashboardLine = value === 'all' || LINES.includes(String(value)) ? String(value) : 'all';
    render(false);
  };

  window.shiftDashboardMonth = function(delta) {
    const [y, m] = String(state.cmms.dashboardMonth || currentMonthKey()).split('-').map(Number);
    const d = new Date(y, m - 1 + Number(delta || 0), 1);
    state.cmms.dashboardMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    render(false);
  };

  window.togglePresentationMode = function() {
    state.cmms.presentationMode = !state.cmms.presentationMode;
    document.body.classList.toggle('cmms-presentation', state.cmms.presentationMode);
    render(false);
  };

  function pdfKpi(doc, x, y, w, label, value) {
    doc.setDrawColor(210);
    doc.roundedRect(x, y, w, 22, 2, 2);
    doc.setFontSize(7);
    doc.setTextColor(100);
    doc.text(label.toUpperCase(), x + 4, y + 7);
    doc.setFontSize(15);
    doc.setTextColor(20);
    doc.text(String(value), x + 4, y + 17);
  }

  function exportParetoTable(doc, title, rows, startY) {
    doc.setFontSize(11);
    doc.setTextColor(20);
    doc.text(title, 14, startY);
    const body = rows.length ? rows.map(([name, count], i) => [String(i + 1), name, String(count)]) : [['-', 'Sem dados', '0']];
    doc.autoTable({ startY: startY + 4, head: [['#', 'Item', 'Qtd.']], body, theme: 'grid', styles: { fontSize: 8 }, headStyles: { fillColor: [45, 50, 58] } });
    return doc.lastAutoTable.finalY;
  }

  window.exportDashboardPDF = function() {
    if (!window.jspdf?.jsPDF) return showToast('Exportação PDF indisponível neste navegador.', 'error');
    const month = state.cmms.dashboardMonth || currentMonthKey();
    const line = state.cmms.dashboardLine || 'all';
    const m = metricSet(month, line);
    const prev = metricSet(previousMonthKey(month), line);
    const mtbf = mtbfDays(m.corr);
    const mttr = mttrMinutes(m.osCompleted);
    const doc = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const scope = line === 'all' ? 'Todas as linhas' : `L${line}`;

    doc.setFontSize(18); doc.setTextColor(20); doc.text('Sala de Válvulas - Relatório de Manutenção', 14, 15);
    doc.setFontSize(9); doc.setTextColor(90); doc.text(`${monthLabel(month)} | ${scope}`, 14, 21);

    const values = [
      ['Intervenções', m.hist.length], ['Corretivas', m.corr.length], ['Preventivas', m.prev.length], ['Falhas enchedora', m.falhas.length],
      ['OS concluídas', m.osCompleted.length], ['Ordens SAP', m.sap.length], ['Plano executado', `${m.plan.pct}%`], ['Reincidências', m.recurrence.length]
    ];
    values.forEach((row, i) => pdfKpi(doc, 14 + (i % 4) * 69, 28 + Math.floor(i / 4) * 27, 64, row[0], row[1]));

    doc.setFontSize(10); doc.setTextColor(20); doc.text('Indicadores técnicos', 14, 87);
    doc.setFontSize(8); doc.setTextColor(80);
    doc.text(`MTBF do período: ${mtbf == null ? '-' : mtbf.toFixed(1) + ' dias'}   |   MTTR das OS concluídas: ${formatMttr(mttr)}`, 14, 93);
    doc.text(`Comparação com ${monthLabel(previousMonthKey(month))}: corretivas ${m.corr.length} vs ${prev.corr.length}; preventivas ${m.prev.length} vs ${prev.prev.length}; plano ${m.plan.pct}% vs ${prev.plan.pct}%.`, 14, 99);

    let y1 = exportParetoTable(doc, 'Pareto de válvulas corretivas', pareto(m.corr, h => `L${h.line}/V${h.valve}`), 109);
    let y2 = exportParetoTable(doc, 'Pareto de componentes', pareto(m.corr, h => h.subset || 'Geral'), 109);
    if (y2 > y1) y1 = y2;

    doc.addPage();
    doc.setFontSize(15); doc.setTextColor(20); doc.text(`Planejamento preventivo - ${monthLabel(month)}`, 14, 15);
    const planRows = m.plans.length ? m.plans.map(p => {
      const valves = (p.valves || []).map(Number);
      const completed = new Set((p.completedValves || []).map(Number));
      const done = valves.filter(v => completed.has(v)).length;
      return [`L${p.line}`, valves.length ? `V${valves[0]} a V${valves[valves.length - 1]}` : '-', `${done}/${valves.length}`, valves.length ? `${Math.round(done / valves.length * 100)}%` : '0%', (p.linkedSapOrderIds || []).join(', ') || '-'];
    }) : [['-', 'Sem programação', '0/0', '0%', '-']];
    doc.autoTable({ startY: 22, head: [['Linha', 'Sequência', 'Executado', 'Cumprimento', 'Ordens SAP vinculadas']], body: planRows, theme: 'grid', styles: { fontSize: 8 }, headStyles: { fillColor: [45, 50, 58] } });

    const sapY = doc.lastAutoTable.finalY + 10;
    doc.setFontSize(11); doc.text('Ordens SAP do período', 14, sapY);
    const sapRows = m.sap.length ? m.sap.map(o => [o.sapOrderNumber || o.id, o.line ? `L${o.line}` : '-', o.description || '-', o.status || '-']) : [['-', '-', 'Nenhuma ordem SAP no período', '-']];
    doc.autoTable({ startY: sapY + 4, head: [['Ordem', 'Linha', 'Descrição', 'Status']], body: sapRows, theme: 'grid', styles: { fontSize: 7 }, headStyles: { fillColor: [45, 50, 58] } });

    const recY = doc.lastAutoTable.finalY + 10;
    doc.setFontSize(11); doc.text('Reincidências', 14, recY);
    doc.autoTable({ startY: recY + 4, head: [['Local / componente', 'Corretivas']], body: m.recurrence.length ? m.recurrence.map(([k, rows]) => [k, String(rows.length)]) : [['Sem reincidências (3+ no mês)', '0']], theme: 'grid', styles: { fontSize: 8 }, headStyles: { fillColor: [45, 50, 58] } });

    doc.save(`Relatorio_Manutencao_${month}_${line === 'all' ? 'Geral' : 'L' + line}.pdf`);
    showToast('Relatório PDF gerado.', 'success');
  };

  window.renderDashboardView = function(c) {
    const month = state.cmms.dashboardMonth || currentMonthKey();
    const line = state.cmms.dashboardLine || 'all';
    const previousMonth = previousMonthKey(month);
    const m = metricSet(month, line);
    const p = metricSet(previousMonth, line);
    const corrDelta = variation(m.corr.length, p.corr.length, true);
    const prevDelta = variation(m.prev.length, p.prev.length, false);
    const planDelta = pointsVariation(m.plan.pct, p.plan.pct);
    const totalDelta = variation(m.hist.length, p.hist.length, false);
    const mtbf = mtbfDays(m.corr);
    const mttr = mttrMinutes(m.osCompleted);
    const topValves = pareto(m.corr, h => `L${h.line}/V${h.valve}`);
    const topComponents = pareto(m.corr, h => h.subset || 'Geral');
    const sapValue = m.sap.reduce((sum, o) => sum + Number(o.totalValue || 0), 0);
    const hasSapValue = sapValue > 0;
    const scope = line === 'all' ? 'Todas as linhas' : `L${line}`;

    document.body.classList.toggle('cmms-presentation', !!state.cmms.presentationMode);

    c.innerHTML = `<div class="space-y-4 report-dashboard">
      <div class="report-title-row"><div><div class="cmms-section-title">Relatório técnico e PCM</div><h2 class="text-2xl font-bold">Dashboard de Manutenção</h2><div class="report-period">${esc(monthLabel(month))} · ${esc(scope)}</div></div><div class="cmms-badge ${m.plan.planned && m.plan.pct >= 100 ? 'ok' : m.plan.planned ? 'warn' : ''}">${m.plan.planned ? `${m.plan.done}/${m.plan.planned} preventivas planejadas` : 'Sem plano preventivo no período'}</div></div>

      <div class="report-toolbar">
        <div class="report-toolbar-controls">
          <button class="report-action" onclick="shiftDashboardMonth(-1)" title="Mês anterior"><i data-lucide="chevron-left" class="w-4 h-4"></i></button>
          <div class="report-field"><label>Mês do relatório</label><input type="month" value="${esc(month)}" onchange="setDashboardMonth(this.value)"></div>
          <button class="report-action" onclick="shiftDashboardMonth(1)" title="Próximo mês"><i data-lucide="chevron-right" class="w-4 h-4"></i></button>
          <div class="report-field"><label>Linha</label><select onchange="setDashboardLine(this.value)"><option value="all" ${line === 'all' ? 'selected' : ''}>Todas as linhas</option>${LINES.map(l => `<option value="${l}" ${line === l ? 'selected' : ''}>L${l}</option>`).join('')}</select></div>
        </div>
        <div class="report-actions"><button class="report-action pdf" onclick="exportDashboardPDF()"><i data-lucide="file-down" class="w-4 h-4"></i> Exportar PDF</button><button class="report-action primary" onclick="togglePresentationMode()"><i data-lucide="${state.cmms.presentationMode ? 'minimize-2' : 'presentation'}" class="w-4 h-4"></i>${state.cmms.presentationMode ? 'Sair da apresentação' : 'Modo apresentação'}</button></div>
      </div>

      <div class="report-kpis">
        ${kpi('Intervenções', m.hist.length, `${m.corr.length} corretivas + ${m.prev.length} preventivas`)}
        ${kpi('Corretivas', m.corr.length, corrDelta.text, m.corr.length > p.corr.length ? 'bad' : m.corr.length < p.corr.length ? 'good' : '')}
        ${kpi('Preventivas', m.prev.length, prevDelta.text, m.prev.length > p.prev.length ? 'good' : '')}
        ${kpi('Plano executado', m.plan.planned ? `${m.plan.pct}%` : '-', m.plan.planned ? `${m.plan.done} de ${m.plan.planned}` : 'sem programação', m.plan.planned && m.plan.pct >= 100 ? 'good' : m.plan.planned ? 'warn' : '')}
        ${kpi('Falhas enchedora', m.falhas.length, 'eventos gerais')}
        ${kpi('OS concluídas', m.osCompleted.length, `${m.osCreated.length} criadas no mês`)}
        ${kpi('Ordens SAP', m.sap.length, hasSapValue ? Number(sapValue).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : 'sem custo neste relatório')}
        ${kpi('Reincidências', m.recurrence.length, '3+ corretivas no mesmo ponto', m.recurrence.length ? 'bad' : 'good')}
      </div>

      <div class="report-panel"><div class="report-panel-title"><h3>Execução das preventivas</h3><span>programação mandatória do mês</span></div><div class="report-plans">${linePlanCards(m.plans, line)}</div></div>

      <div class="report-grid-2">
        <div class="report-panel"><div class="report-panel-title"><h3>Pareto · válvulas corretivas</h3><span>top ${topValves.length || 0}</span></div>${barRows(topValves, 'Nenhuma corretiva no período.')}</div>
        <div class="report-panel"><div class="report-panel-title"><h3>Pareto · componentes</h3><span>corretivas do período</span></div>${barRows(topComponents, 'Nenhuma corretiva no período.')}</div>
      </div>

      <div class="report-grid-2">
        <div class="report-panel"><div class="report-panel-title"><h3>Comparação com ${esc(monthLabel(previousMonth))}</h3><span>evolução mensal</span></div><div class="report-compare">
          <div class="report-compare-row"><span class="name">Corretivas</span><span class="num">${p.corr.length} → ${m.corr.length}</span><span class="report-delta ${corrDelta.cls}">${esc(corrDelta.text)}</span><span></span></div>
          <div class="report-compare-row"><span class="name">Preventivas</span><span class="num">${p.prev.length} → ${m.prev.length}</span><span class="report-delta ${prevDelta.cls}">${esc(prevDelta.text)}</span><span></span></div>
          <div class="report-compare-row"><span class="name">Cumprimento do plano</span><span class="num">${p.plan.pct}% → ${m.plan.pct}%</span><span class="report-delta ${planDelta.cls}">${esc(planDelta.text)}</span><span></span></div>
          <div class="report-compare-row"><span class="name">Intervenções totais</span><span class="num">${p.hist.length} → ${m.hist.length}</span><span class="report-delta ${totalDelta.cls}">${esc(totalDelta.text)}</span><span></span></div>
        </div></div>
        <div class="report-panel"><div class="report-panel-title"><h3>Confiabilidade e tempo de reparo</h3><span>dados disponíveis no período</span></div><div class="report-kpis" style="grid-template-columns:repeat(2,minmax(0,1fr))">${kpi('MTBF do período', mtbf == null ? '-' : `${mtbf.toFixed(1)} d`, mtbf == null ? 'precisa de 2+ falhas por válvula' : 'média entre corretivas')}${kpi('MTTR das OS', formatMttr(mttr), mttr == null ? 'sem OS com início e fim' : `${m.osCompleted.length} OS concluídas`)}</div></div>
      </div>

      <div class="report-grid-2">
        <div class="report-panel"><div class="report-panel-title"><h3>Reincidências do mês</h3><span>mesmo local + componente</span></div>${m.recurrence.length ? m.recurrence.slice(0, 10).map(([name, rows]) => `<div class="report-recurrence"><b>${rows.length}x</b><div><strong>${esc(name)}</strong><small>corretivas no período</small></div></div>`).join('') : '<div class="report-empty">Nenhuma reincidência com 3 ou mais corretivas.</div>'}</div>
        <div class="report-panel"><div class="report-panel-title"><h3>Ordens SAP</h3><span>${m.sap.length} no período</span></div>${m.sap.length ? m.sap.slice(0, 10).map(o => `<div class="report-recurrence"><b style="color:#e8b800">SAP</b><div><strong>${esc(o.sapOrderNumber || o.id)}</strong><small>${esc(o.line ? 'L' + o.line + ' · ' : '')}${esc(o.description || o.status || '')}</small></div></div>`).join('') : '<div class="report-empty">Nenhuma ordem SAP cadastrada para este mês.</div>'}</div>
      </div>
    </div>`;

    if (window.lucide) lucide.createIcons();
  };

  injectStyles();
  subscribe();
})();
