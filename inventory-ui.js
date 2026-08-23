/* Sala de Válvulas - Materiais, estoque e custos */
(() => {
  'use strict';

  const MATERIAL_LINES = ['512', '513', '514'];
  const materialsDB = {};
  const profilesDB = {};
  let wrapped = false;

  state.cmms = Object.assign({
    orderTab: 'sap',
    inventorySearch: '',
    inventoryLine: 'all',
    inventorySubset: 'all'
  }, state.cmms || {});

  function esc(v) {
    return String(v ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }
  function money(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }
  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  function uniq(values) {
    return [...new Set((values || []).map(v => String(v).trim()).filter(Boolean))];
  }
  function splitList(value) {
    return uniq(String(value || '').split(',').map(v => v.trim()));
  }
  function safeDocId(value) {
    return String(value || '').trim().replaceAll('/', '-').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  }
  function checkbox(id, label, checked) {
    return `<label class="inventory-check"><input id="${id}" type="checkbox" ${checked ? 'checked' : ''}><span>${label}</span></label>`;
  }

  function installStyles() {
    if (document.getElementById('inventory-ui-style')) return;
    const style = document.createElement('style');
    style.id = 'inventory-ui-style';
    style.textContent = `
      .inventory-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
      .inventory-toolbar .input-industrial{min-height:44px}
      .inventory-search{flex:1 1 220px;min-width:180px}
      .inventory-filter{flex:0 1 160px;min-width:130px}
      .inventory-card{background:#0c111a;border:1px solid #1d293a;border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:9px}
      .inventory-card .code{font-family:'JetBrains Mono',monospace;color:#e8b800;font-size:.85rem;font-weight:800}
      .inventory-meta{display:flex;gap:6px;flex-wrap:wrap}
      .inventory-meta span{border:1px solid #26344a;border-radius:999px;padding:4px 7px;color:#94a3b8;font-size:9px;font-weight:800}
      .inventory-cost-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}
      .inventory-cost-grid div{background:#090e15;border:1px solid #172235;border-radius:10px;padding:8px;min-width:0}
      .inventory-cost-grid small{display:block;color:#6f7d91;text-transform:uppercase;font-size:8px;font-weight:800;letter-spacing:.06em}
      .inventory-cost-grid strong{display:block;margin-top:3px;font-size:.82rem;overflow-wrap:anywhere}
      .inventory-checks{display:flex;gap:8px;flex-wrap:wrap}
      .inventory-check{display:flex;align-items:center;gap:6px;padding:8px 10px;border:1px solid #26344a;border-radius:10px;background:#0b111a;font-size:12px;color:#cbd5e1}
      .inventory-check input{accent-color:#e8b800}
      .inventory-reference{border:1px solid rgba(232,184,0,.25);background:rgba(232,184,0,.05);border-radius:12px;padding:11px;color:#aeb8c8;font-size:11px;line-height:1.5}
      .inventory-reference strong{color:#e8b800}
      .inventory-profile{background:#0a1018;border:1px solid #1d293a;border-radius:12px;padding:12px}
      .inventory-low{color:#fca5a5!important}
      @media(max-width:520px){
        .inventory-filter{flex:1 1 46%;min-width:0}
        .inventory-cost-grid{grid-template-columns:1fr 1fr}
        .inventory-cost-grid div:last-child{grid-column:1/-1}
      }
    `;
    document.head.appendChild(style);
  }

  function materialSubsets() {
    return uniq(Object.values(materialsDB).flatMap(m => m.applicableSubsets || [])).sort((a,b)=>a.localeCompare(b,'pt-BR'));
  }

  function filteredMaterials() {
    const q = String(state.cmms.inventorySearch || '').trim().toLowerCase();
    const line = String(state.cmms.inventoryLine || 'all');
    const subset = String(state.cmms.inventorySubset || 'all');
    return Object.values(materialsDB)
      .filter(m => m.active !== false)
      .filter(m => line === 'all' || (m.applicableLines || []).map(String).includes(line))
      .filter(m => subset === 'all' || (m.applicableSubsets || []).includes(subset))
      .filter(m => !q || [m.sapCode,m.description,m.manufacturerCode,(m.applicableSubsets||[]).join(' '),(m.bannerRefs||[]).join(' '),(m.applicationNotes||[]).join(' ')].join(' ').toLowerCase().includes(q))
      .sort((a,b)=>String(a.sapCode||'').localeCompare(String(b.sapCode||'')));
  }

  function inventoryKpis() {
    const rows = Object.values(materialsDB).filter(m => m.active !== false);
    const withCost = rows.filter(m => Number(m.unitCost || 0) > 0).length;
    const knownStock = rows.filter(m => m.stockQty !== undefined && m.stockQty !== null && m.stockQty !== '').length;
    const low = rows.filter(m => Number(m.minStock || 0) > 0 && Number(m.stockQty || 0) <= Number(m.minStock || 0)).length;
    const totalValue = rows.reduce((sum,m)=>sum + num(m.stockQty) * num(m.unitCost), 0);
    return { rows, withCost, knownStock, low, totalValue };
  }

  function renderInventoryView(c) {
    const rows = filteredMaterials();
    const k = inventoryKpis();
    const subsets = materialSubsets();
    const profiles = Object.values(profilesDB).sort((a,b)=>String(a.subset||'').localeCompare(String(b.subset||''),'pt-BR'));

    c.innerHTML = `<div class="space-y-4 pb-6">
      <div class="flex justify-between items-start gap-3">
        <div>
          <button onclick="backToOrdersFromInventory()" class="text-xs text-gray-400 mb-2 flex items-center gap-1"><i data-lucide="arrow-left" class="w-4 h-4"></i> Ordens</button>
          <div class="cmms-section-title mb-1">almoxarifado + custo técnico</div>
          <h2 class="text-2xl font-bold">Materiais & Estoque</h2>
          <div class="text-xs text-gray-500 mt-1">Código SAP, aplicação por subconjunto, saldo, valor e periodicidade.</div>
        </div>
        <button onclick="openMaterialEditor()" class="btn-industrial bg-primary text-black px-4 py-3 text-xs whitespace-nowrap">+ MATERIAL</button>
      </div>

      <div class="cmms-grid-auto">
        <div class="cmms-kpi"><small>Materiais cadastrados</small><strong>${k.rows.length}</strong></div>
        <div class="cmms-kpi"><small>Com saldo informado</small><strong>${k.knownStock}</strong></div>
        <div class="cmms-kpi"><small>Com valor unitário</small><strong>${k.withCost}</strong></div>
        <div class="cmms-kpi"><small>Valor conhecido em estoque</small><strong style="font-size:1.15rem" class="text-primary">${money(k.totalValue)}</strong></div>
      </div>

      <div class="inventory-toolbar card-industrial p-3">
        <input class="input-industrial inventory-search" placeholder="Buscar código, peça, subconjunto..." value="${esc(state.cmms.inventorySearch || '')}" oninput="setInventoryFilter('inventorySearch',this.value)">
        <select class="input-industrial inventory-filter" onchange="setInventoryFilter('inventoryLine',this.value)">
          <option value="all">Todas as linhas</option>${MATERIAL_LINES.map(l=>`<option value="${l}" ${String(state.cmms.inventoryLine)==l?'selected':''}>L${l}</option>`).join('')}
        </select>
        <select class="input-industrial inventory-filter" onchange="setInventoryFilter('inventorySubset',this.value)">
          <option value="all">Todos subconjuntos</option>${subsets.map(s=>`<option value="${esc(s)}" ${String(state.cmms.inventorySubset)===s?'selected':''}>${esc(s)}</option>`).join('')}
        </select>
      </div>

      ${k.low ? `<div class="cmms-alert"><i data-lucide="triangle-alert" class="w-5 h-5 text-red-400"></i><div><strong class="text-red-300">${k.low} material(is) no mínimo de estoque</strong><div class="text-xs text-gray-500">O alerta só considera itens com estoque mínimo preenchido.</div></div></div>` : ''}

      <div class="inventory-reference"><strong>Regra financeira:</strong> material previsto/requisitado não é consumo. O custo realizado só entra no histórico quando uma preventiva ou corretiva for confirmada. O valor gravado na manutenção fica congelado naquela data.</div>

      <div>
        <div class="cmms-section-title">Catálogo técnico · ${rows.length} item(ns)</div>
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          ${rows.length ? rows.map(m=>{
            const stock = m.stockQty === undefined || m.stockQty === null || m.stockQty === '' ? '—' : `${num(m.stockQty)} ${esc(m.unit || 'UN')}`;
            const unitCost = Number(m.unitCost || 0) > 0 ? money(m.unitCost) : '—';
            const total = Number(m.unitCost || 0) > 0 && m.stockQty !== undefined ? money(num(m.stockQty)*num(m.unitCost)) : '—';
            const low = Number(m.minStock || 0)>0 && num(m.stockQty)<=num(m.minStock);
            const lines=(m.applicableLines||[]).map(l=>'L'+l);
            const subsets=(m.applicableSubsets||[]);
            const banners=(m.bannerRefs||[]);
            const apps=(m.applicationNotes||[]);
            return `<div class="inventory-card">
              <div class="flex justify-between gap-3 items-start"><div><div class="code">SAP ${esc(m.sapCode||m.id)}</div><strong class="text-sm">${esc(m.description||'Sem descrição')}</strong>${m.manufacturerCode?`<div class="text-[10px] text-gray-500 mt-1">Fab.: ${esc(m.manufacturerCode)}</div>`:''}</div><button onclick='openMaterialEditor(${JSON.stringify(String(m.id||m.sapCode||''))})' class="p-2 text-gray-400"><i data-lucide="pencil" class="w-4 h-4"></i></button></div>
              <div class="inventory-meta">${[...lines,...subsets,...banners].map(v=>`<span>${esc(v)}</span>`).join('') || '<span>associação pendente</span>'}</div>
              ${apps.length?`<div class="text-[10px] text-gray-400">${apps.map(esc).join(' · ')}</div>`:''}
              ${m.replacementIntervalHours?`<div class="cmms-badge warn">troca ${num(m.replacementIntervalHours).toLocaleString('pt-BR')} h${m.replacementDueYear?` · prevista ${esc(m.replacementDueYear)}`:''}</div>`:''}
              <div class="inventory-cost-grid"><div><small>Estoque</small><strong class="${low?'inventory-low':''}">${stock}</strong></div><div><small>Valor unit.</small><strong>${unitCost}</strong></div><div><small>Valor estoque</small><strong>${total}</strong></div></div>
              ${m.referenceSapOrders?.length?`<div class="text-[9px] text-gray-600">Ref. SAP: ${m.referenceSapOrders.map(esc).join(', ')}</div>`:''}
            </div>`;
          }).join('') : '<div class="cmms-empty col-span-full">Nenhum material encontrado com esses filtros.</div>'}
        </div>
      </div>

      <div>
        <div class="cmms-section-title">Perfis / receitas em construção</div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">${profiles.length ? profiles.map(p=>`<div class="inventory-profile"><div class="flex justify-between gap-2"><strong>${esc(p.subset||p.profileId)}</strong><span class="cmms-badge ${p.recipeConfirmed?'ok':'warn'}">${p.recipeConfirmed?'receita confirmada':'referência'}</span></div><div class="text-[10px] text-gray-500 mt-1">${(p.lines||[]).map(l=>'L'+esc(l)).join(' · ') || 'linha pendente'} · ${(p.materialCodes||[]).length} materiais</div>${Number(p.referencePlannedMaterialValue||0)>0?`<div class="text-sm text-primary font-bold mt-2">${money(p.referencePlannedMaterialValue)} <span class="text-[9px] text-gray-500 font-normal">valor de referência da ordem</span></div>`:''}</div>`).join('') : '<div class="cmms-empty col-span-full">Nenhum perfil criado.</div>'}</div>
      </div>
    </div>`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  function addInventoryShortcut(c) {
    if (!c || c.querySelector('#open-inventory-btn')) return;
    const header = c.querySelector('.flex.justify-between.items-end');
    if (!header) return;
    const actions = document.createElement('div');
    actions.className='flex gap-2 flex-wrap justify-end';
    actions.innerHTML = `<button id="open-inventory-btn" onclick="openInventoryManager()" class="btn-industrial bg-secondary border border-gray-700 px-3 py-3 text-xs"><i data-lucide="package-search" class="w-4 h-4 inline mr-1"></i> MATERIAIS</button>`;
    const existing = header.querySelector('button');
    if (existing) {
      existing.parentElement === header && header.removeChild(existing);
      actions.appendChild(existing);
    }
    header.appendChild(actions);
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  window.openInventoryManager = function() {
    state.mode='orders'; state.cmms.orderTab='materials'; render(false);
  };
  window.backToOrdersFromInventory = function() {
    state.cmms.orderTab='sap'; render(false);
  };
  window.setInventoryFilter = function(key, value) {
    state.cmms[key]=value;
    const c=document.getElementById('main-container');
    if (c && state.mode==='orders' && state.cmms.orderTab==='materials') renderInventoryView(c);
  };

  window.openMaterialEditor = function(id='') {
    const m = id ? (materialsDB[id] || Object.values(materialsDB).find(x=>String(x.sapCode)===String(id))) : null;
    const lines = (m?.applicableLines || []).map(String);
    const subsets = (m?.applicableSubsets || []).join(', ');
    const banners = (m?.bannerRefs || []).join(', ');
    const applications = (m?.applicationNotes || []).join(', ');
    const title = m ? `Editar material ${esc(m.sapCode)}` : 'Novo material';
    const body = `<div class="space-y-3">
      <div class="grid grid-cols-2 gap-3"><div><label class="label-industrial">Código SAP</label><input id="inv-code" class="input-industrial font-mono" value="${esc(m?.sapCode||'')}" ${m?'disabled':''}></div><div><label class="label-industrial">Unidade</label><input id="inv-unit" class="input-industrial" value="${esc(m?.unit||'UN')}"></div></div>
      <div><label class="label-industrial">Descrição</label><input id="inv-desc" class="input-industrial" value="${esc(m?.description||'')}"></div>
      <div><label class="label-industrial">Código fabricante / referência</label><input id="inv-fab" class="input-industrial" value="${esc(m?.manufacturerCode||'')}"></div>
      <div><label class="label-industrial">Linhas onde aplica</label><div class="inventory-checks">${MATERIAL_LINES.map(l=>checkbox(`inv-line-${l}`,`L${l}`,lines.includes(l))).join('')}</div></div>
      <div><label class="label-industrial">Subconjunto(s)</label><input id="inv-subsets" class="input-industrial" placeholder="Tulipa, V3, V5/V6..." value="${esc(subsets)}"></div>
      <div><label class="label-industrial">Referência no banner / mapa</label><input id="inv-banners" class="input-industrial" placeholder="F-2, A-3/C-3..." value="${esc(banners)}"></div>
      <div><label class="label-industrial">Aplicação / local na máquina</label><textarea id="inv-app" class="input-industrial" rows="2">${esc(applications)}</textarea></div>
      <div class="grid grid-cols-3 gap-3"><div><label class="label-industrial">Estoque</label><input id="inv-stock" type="number" step="0.001" class="input-industrial" value="${m?.stockQty ?? ''}"></div><div><label class="label-industrial">Estoque mín.</label><input id="inv-min" type="number" step="0.001" class="input-industrial" value="${m?.minStock ?? ''}"></div><div><label class="label-industrial">Valor unit. R$</label><input id="inv-cost" type="number" step="0.01" class="input-industrial" value="${m?.unitCost ?? ''}"></div></div>
      <div class="grid grid-cols-2 gap-3"><div><label class="label-industrial">Troca por horas</label><input id="inv-hours" type="number" class="input-industrial" value="${m?.replacementIntervalHours ?? ''}"></div><div><label class="label-industrial">Ano previsto</label><input id="inv-year" type="number" class="input-industrial" value="${m?.replacementDueYear ?? ''}"></div></div>
      <button onclick='saveMaterialEditor(${JSON.stringify(String(m?.id||''))})' class="btn-industrial bg-primary text-black w-full py-3">SALVAR MATERIAL</button>
      <div class="text-[10px] text-gray-500">Editar cadastro não gera consumo. Baixa de estoque e custo realizado serão ligados à manutenção em etapa posterior.</div>
    </div>`;
    if (typeof openModal === 'function') openModal(title, body);
  };

  window.saveMaterialEditor = async function(existingId='') {
    const code = String(document.getElementById('inv-code')?.value || '').trim();
    const description = String(document.getElementById('inv-desc')?.value || '').trim();
    if (!code || !description) return showToast?.('Código SAP e descrição são obrigatórios.','error');
    const lines = MATERIAL_LINES.filter(l=>document.getElementById(`inv-line-${l}`)?.checked);
    const existing = existingId ? materialsDB[existingId] : null;
    const data = {
      sapCode: code,
      description,
      manufacturerCode: String(document.getElementById('inv-fab')?.value || '').trim(),
      unit: String(document.getElementById('inv-unit')?.value || 'UN').trim() || 'UN',
      applicableLines: lines,
      applicableSubsets: splitList(document.getElementById('inv-subsets')?.value),
      bannerRefs: splitList(document.getElementById('inv-banners')?.value),
      applicationNotes: splitList(document.getElementById('inv-app')?.value),
      stockQty: document.getElementById('inv-stock')?.value === '' ? null : num(document.getElementById('inv-stock')?.value),
      minStock: document.getElementById('inv-min')?.value === '' ? null : num(document.getElementById('inv-min')?.value),
      unitCost: document.getElementById('inv-cost')?.value === '' ? null : num(document.getElementById('inv-cost')?.value),
      currency: 'BRL',
      replacementIntervalHours: document.getElementById('inv-hours')?.value === '' ? null : num(document.getElementById('inv-hours')?.value),
      replacementDueYear: document.getElementById('inv-year')?.value === '' ? null : num(document.getElementById('inv-year')?.value),
      active: true,
      source: existing?.source || 'manual_app',
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    try {
      await db.collection('materials').doc(existingId || safeDocId(code)).set(data,{merge:true});
      if (typeof closeModal === 'function') closeModal();
      if (typeof showToast === 'function') showToast('Material salvo.','success');
    } catch (err) {
      console.error('save material', err);
      if (typeof showToast === 'function') showToast('Falha ao salvar material.','error');
    }
  };

  function wrapOrders(attempt=0) {
    if (wrapped) return;
    if (typeof window.renderOrdersView !== 'function') {
      if (attempt < 40) setTimeout(()=>wrapOrders(attempt+1),50);
      return;
    }
    const base = window.renderOrdersView;
    window.renderOrdersView = function(c) {
      if (state?.cmms?.orderTab === 'materials') return renderInventoryView(c);
      const out = base.apply(this, arguments);
      addInventoryShortcut(c);
      return out;
    };
    wrapped = true;
    if (state?.mode === 'orders') render(false);
  }

  installStyles();
  if (typeof db !== 'undefined') {
    db.collection('materials').onSnapshot(snap=>{
      Object.keys(materialsDB).forEach(k=>delete materialsDB[k]);
      snap.forEach(doc=>{materialsDB[doc.id]={id:doc.id,...doc.data()};});
      if (state?.mode==='orders' && state?.cmms?.orderTab==='materials') render(false);
    }, err=>console.warn('materials listener',err));
    db.collection('maintenance_material_profiles').onSnapshot(snap=>{
      Object.keys(profilesDB).forEach(k=>delete profilesDB[k]);
      snap.forEach(doc=>{profilesDB[doc.id]={id:doc.id,...doc.data()};});
      if (state?.mode==='orders' && state?.cmms?.orderTab==='materials') render(false);
    }, err=>console.warn('profiles listener',err));
  }
  setTimeout(()=>wrapOrders(0),0);
})();
