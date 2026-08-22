/* Sala de Válvulas CMMS v2
 * Camada de evolução profissional sobre o app atual.
 * Mantém compatibilidade visual/operacional e migra o histórico para documentos individuais.
 */
(() => {
  'use strict';

  const APP_VERSION = '2.0.0';
  const HISTORY_MARKER = db.collection('system').doc('history_v2');
  const PLAN_TARGETS = { '512': 14, '513': 14, '514': 10 };
  const CMMS_LINES = ['512', '513', '514'];
  const MAX_VALVES = { '512': 175, '513': 175, '514': 72 };

  const legacyRenderRegisterFlow = renderRegisterFlow;
  const legacyGetFilteredData = getFilteredData;
  const legacyExportData = exportData;
  const legacyRenderOps = renderOps;

  let historyV2Ready = false;
  let historyDB = {};
  let sapOrdersDB = {};
  let maintenancePlansDB = {};
  let workOrdersDB = {};
  let cmmsLoaded = false;

  state.filters = Object.assign({
    line: 'all', valve: '', historyType: 'all', startDate: '', endDate: '',
    searchText: '', subset: 'all', sort: 'newest'
  }, state.filters || {});

  state.cmms = Object.assign({ orderTab: 'sap', dashboardPeriod: 'month' }, state.cmms || {});

  function esc(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  function isoNow() { return new Date().toISOString(); }
  function localDateInput(iso) {
    const d = iso ? new Date(iso) : new Date();
    if (Number.isNaN(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function toIsoFromLocal(v) { return v ? new Date(v).toISOString() : isoNow(); }
  function currency(v) { return Number(v || 0).toLocaleString('pt-BR', { style:'currency', currency:'BRL' }); }
  function monthKey(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
  function monthLabel(key) {
    if (!key) return '-';
    const [y,m] = key.split('-').map(Number);
    return new Date(y, m-1, 1).toLocaleDateString('pt-BR', { month:'long', year:'numeric' });
  }
  function historyRef(line, valve, id) {
    return db.collection('lines').doc(String(line)).collection('valves').doc(String(valve)).collection('history').doc(String(id));
  }
  function parseHistoryPath(path) {
    const p = String(path || '').split('/');
    return { line: p[1] || '', valve: p[3] || '', id: p[5] || '' };
  }
  function currentMonthBounds() {
    const n = new Date();
    const start = new Date(n.getFullYear(), n.getMonth(), 1);
    const end = new Date(n.getFullYear(), n.getMonth()+1, 0);
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    return [fmt(start), fmt(end)];
  }

  function injectProfessionalStyles() {
    if (document.getElementById('cmms-v2-style')) return;
    const style = document.createElement('style');
    style.id = 'cmms-v2-style';
    style.textContent = `
      :root{--cmms-panel:#0a0f17;--cmms-border:#1c2737;--cmms-muted:#7f8da3;--cmms-yellow:#e8b800}
      body{padding-bottom:74px}
      .cmms-bottom-nav{position:fixed;z-index:45;left:50%;bottom:12px;transform:translateX(-50%);width:min(760px,calc(100% - 20px));height:62px;background:rgba(8,12,19,.96);border:1px solid #202d40;border-radius:18px;box-shadow:0 18px 50px rgba(0,0,0,.5);backdrop-filter:blur(14px);display:grid;grid-template-columns:repeat(5,1fr);padding:6px}
      .cmms-nav-btn{border-radius:13px;color:#76849a;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font-size:10px;font-weight:700;letter-spacing:.02em;transition:.18s}
      .cmms-nav-btn.active{background:#e8b800;color:#090c12;box-shadow:0 5px 18px rgba(232,184,0,.18)}
      .cmms-nav-btn svg{width:20px;height:20px}
      .cmms-kpi{background:linear-gradient(145deg,#0e1520,#0a0f17);border:1px solid #1d2a3d;border-radius:14px;padding:16px;min-height:104px}
      .cmms-kpi strong{font-family:'JetBrains Mono',monospace;font-size:1.7rem;display:block;margin-top:5px}
      .cmms-kpi small{color:#738198;font-weight:700;text-transform:uppercase;letter-spacing:.08em;font-size:.65rem}
      .cmms-section-title{font-size:.72rem;text-transform:uppercase;letter-spacing:.12em;color:#8b99ad;font-weight:800;margin-bottom:10px}
      .cmms-bar{height:8px;border-radius:999px;background:#182334;overflow:hidden}.cmms-bar>span{display:block;height:100%;background:#e8b800;border-radius:999px}
      .cmms-badge{display:inline-flex;align-items:center;gap:5px;padding:4px 8px;border-radius:999px;font-size:10px;font-weight:800;border:1px solid #2b384c;background:#111824;color:#b7c2d1}
      .cmms-badge.ok{border-color:rgba(34,197,94,.4);color:#86efac;background:rgba(34,197,94,.08)}
      .cmms-badge.warn{border-color:rgba(234,179,8,.45);color:#fde047;background:rgba(234,179,8,.08)}
      .cmms-badge.danger{border-color:rgba(239,68,68,.45);color:#fca5a5;background:rgba(239,68,68,.08)}
      .cmms-filter-chip{padding:7px 10px;border:1px solid #26344a;border-radius:999px;font-size:11px;font-weight:700;color:#9ba8ba;background:#0d141f;white-space:nowrap}
      .cmms-filter-chip.active{color:#090c12;background:#e8b800;border-color:#e8b800}
      .cmms-grid-auto{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
      .cmms-empty{padding:30px;text-align:center;border:1px dashed #26344a;border-radius:14px;color:#6e7c90;background:#0a0f17}
      .cmms-order-card{background:#0c111a;border:1px solid #1d293a;border-radius:14px;padding:14px}
      .cmms-alert{display:flex;gap:10px;padding:11px 12px;border:1px solid #243247;border-radius:12px;background:#0b111a}
      .cmms-search-overlay{position:fixed;z-index:70;inset:0;background:rgba(4,6,10,.86);backdrop-filter:blur(8px);padding:18px;overflow:auto}
      .cmms-search-panel{max-width:760px;margin:5vh auto;background:#0b1018;border:1px solid #25344b;border-radius:18px;padding:16px;box-shadow:0 25px 70px rgba(0,0,0,.55)}
      @media(min-width:900px){body{padding-bottom:88px}.cmms-bottom-nav{bottom:18px}.cmms-kpi strong{font-size:2rem}}
    `;
    document.head.appendChild(style);
  }

  function setupPwa() {
    if (!document.querySelector('link[rel="manifest"]')) {
      const l = document.createElement('link'); l.rel='manifest'; l.href='manifest.webmanifest'; document.head.appendChild(l);
    }
    if (!document.querySelector('meta[name="theme-color"]')) {
      const m=document.createElement('meta'); m.name='theme-color'; m.content='#06080d'; document.head.appendChild(m);
    }
    const apple=document.createElement('meta'); apple.name='apple-mobile-web-app-capable'; apple.content='yes'; document.head.appendChild(apple);
    if ('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('./service-worker.js').catch(()=>{}));
  }

  function enhanceShell() {
    injectProfessionalStyles();
    setupPwa();
    const controls = document.querySelector('header .flex.bg-secondary');
    if (controls) controls.innerHTML = `
      <button onclick="openGlobalSearch()" class="p-2 text-gray-400 hover:text-white" title="Busca global"><i data-lucide="search" class="w-5 h-5"></i></button>
      <button onclick="openAlerts()" class="relative p-2 text-gray-400 hover:text-white" title="Alertas"><i data-lucide="bell" class="w-5 h-5"></i><span id="alert-count" class="hidden absolute -top-1 -right-1 bg-red-600 text-white text-[10px] rounded-full min-w-[17px] h-[17px] px-1 items-center justify-center"></span></button>
      <div class="w-px h-6 bg-gray-700 mx-1"></div>
      <button onclick="openManual()" class="p-2 text-gray-400 hover:text-white" title="Manual"><i data-lucide="book-open" class="w-5 h-5"></i></button>`;

    let nav = document.getElementById('cmms-bottom-nav');
    if (!nav) {
      nav=document.createElement('nav'); nav.id='cmms-bottom-nav'; nav.className='cmms-bottom-nav'; document.body.appendChild(nav);
    }
    nav.innerHTML = [
      ['register','wrench','Registro'],['orders','clipboard-list','Ordens'],['workorders','list-checks','OS'],['history','history','Histórico'],['dashboard','chart-no-axes-combined','Indicadores']
    ].map(([m,i,l])=>`<button id="cmms-tab-${m}" onclick="setMode('${m}')" class="cmms-nav-btn"><i data-lucide="${i}"></i><span>${l}</span></button>`).join('');
    lucide.createIcons();
    updateNavState();
  }

  function updateNavState() {
    ['register','orders','workorders','history','dashboard'].forEach(m=>document.getElementById(`cmms-tab-${m}`)?.classList.toggle('active', state.mode===m));
  }

  function rebuildGlobalHistory() {
    if (!historyV2Ready) return;
    CMMS_LINES.forEach(line => {
      if (!globalDB[line]) globalDB[line] = {};
      Object.values(globalDB[line]).forEach(v => { v.historico = []; });
    });
    Object.values(historyDB).forEach(r => {
      const line=String(r.line), valve=String(r.valve);
      if (!CMMS_LINES.includes(line)) return;
      if (!globalDB[line]) globalDB[line]={};
      if (!globalDB[line][valve]) globalDB[line][valve]={ valveNumber: valve==='GERAL'?0:Number(valve), docId:valve };
      globalDB[line][valve].historico = globalDB[line][valve].historico || [];
      globalDB[line][valve].historico.push(r);
    });
  }

  function startV2Listeners() {
    HISTORY_MARKER.onSnapshot(s => {
      historyV2Ready = !!(s.exists && s.data().completed === true);
      if (historyV2Ready) rebuildGlobalHistory();
      if (cmmsLoaded) render(false);
    });
    db.collectionGroup('history').onSnapshot(snap => {
      historyDB={};
      snap.forEach(doc => {
        const p=parseHistoryPath(doc.ref.path); const d=doc.data();
        historyDB[doc.ref.path]={ ...d, id:d.id||doc.id, historyDocId:doc.id, historyPath:doc.ref.path, line:d.line||p.line, valve:String(d.valve ?? p.valve), docId:p.valve };
      });
      if (historyV2Ready) rebuildGlobalHistory();
      refreshAlertCount();
      if (cmmsLoaded && ['history','dashboard','register','orders'].includes(state.mode)) render(false);
    }, err => console.warn('history listener', err));
    db.collection('sap_orders').onSnapshot(snap=>{
      sapOrdersDB={}; snap.forEach(d=>sapOrdersDB[d.id]={id:d.id,...d.data()});
      refreshAlertCount(); if(cmmsLoaded && ['orders','dashboard'].includes(state.mode)) render(false);
    });
    db.collection('maintenance_plans').onSnapshot(snap=>{
      maintenancePlansDB={}; snap.forEach(d=>maintenancePlansDB[d.id]={id:d.id,...d.data()});
      refreshAlertCount(); if(cmmsLoaded && ['orders','dashboard'].includes(state.mode)) render(false);
    });
    db.collection('work_orders').onSnapshot(snap=>{
      workOrdersDB={}; snap.forEach(d=>workOrdersDB[d.id]={id:d.id,...d.data()});
      refreshAlertCount(); if(cmmsLoaded && ['workorders','dashboard'].includes(state.mode)) render(false);
    });
  }

  // Navegação profissional
  setMode = function(m) {
    state.mode=m; state.step = m==='register' ? (state.step||'line') : state.step;
    window.history.pushState({mode:m,step:state.step},null,''); render(false);
  };

  render = function() {
    if (historyV2Ready) rebuildGlobalHistory();
    const c=document.getElementById('main-container'); if(!c) return; c.innerHTML=''; updateNavState();
    if(state.mode==='register') renderRegisterFlow(c);
    else if(state.mode==='history') renderHistoryView(c);
    else if(state.mode==='orders') renderOrdersView(c);
    else if(state.mode==='workorders') renderWorkOrdersView(c);
    else if(state.mode==='dashboard') renderDashboardView(c);
    else renderRegisterFlow(c);
    lucide.createIcons(); refreshAlertCount();
  };

  // Formulário sem fotos
  renderRegisterFlow = function(c) {
    if (state.step !== 'form') return legacyRenderRegisterFlow(c);
    const TYPES={preventiva:{label:'Preventiva',color:'bg-green-500/20 text-green-500 border-green-500/50'},corretiva:{label:'Corretiva',color:'bg-red-500/20 text-red-500 border-red-500/50'}};
    const subText=state.selectedSubsets.length>1?`${state.selectedSubsets.length} Itens`:(state.selectedSubsets[0]||'-');
    c.innerHTML=`<div class="space-y-5 pb-6 animate-pop-in max-w-2xl mx-auto">
      <button onclick="window.history.back()" class="flex items-center text-gray-400"><i data-lucide="arrow-left" class="w-4 h-4 mr-2"></i> Voltar</button>
      <div class="bg-secondary/50 p-4 rounded-lg border border-gray-700 flex justify-between items-center"><div><span class="text-xs font-bold text-gray-400 uppercase">Local</span><div class="text-lg font-mono font-bold text-foreground">L${esc(state.selectedLine)} • V${esc(state.selectedValve)}</div></div><div class="text-right"><span class="text-xs font-bold text-gray-400 uppercase">Item</span><div class="text-lg font-mono font-bold text-primary">${esc(subText)}</div></div></div>
      <div class="bg-secondary/30 p-3 rounded-lg border border-gray-700/50"><label class="label-industrial text-xs mb-1">Responsável Técnico</label><div class="grid grid-cols-2 gap-3"><input type="text" placeholder="Seu Nome" class="input-industrial font-bold text-yellow-500" value="${esc(state.form.name)}" oninput="state.form.name=this.value"><button onclick="openSmartTurnoPicker('form-turno-txt')" class="w-full text-left p-3 rounded-lg bg-secondary border border-gray-700 h-[46px] flex justify-between items-center"><span id="form-turno-txt" class="${state.form.shift?'text-white font-bold':'text-gray-400'}">${esc(state.form.shift||'Turno')}</span><i data-lucide="chevron-down" class="w-4 h-4"></i></button></div></div>
      <div><label class="label-industrial">Tipo</label><div class="grid grid-cols-2 gap-2">${Object.keys(TYPES).map(t=>`<button onclick="setType('${t}')" class="rounded-lg font-semibold text-sm py-3 border border-transparent ${state.form.type===t?TYPES[t].color+' border-current':'bg-secondary text-gray-400'}">${TYPES[t].label}</button>`).join('')}</div></div>
      <div><label class="label-industrial flex items-center justify-between">Descrição<button type="button" id="mic-btn" onclick="toggleMic()" class="text-gray-400 hover:text-primary transition-colors flex items-center gap-1 text-xs"><i data-lucide="mic" class="w-4 h-4"></i> Áudio</button></label><textarea id="desc" oninput="state.form.description=this.value" class="input-industrial" rows="4" placeholder="O que foi realizado?">${esc(state.form.description)}</textarea></div>
      <div><label class="label-industrial">Tags rápidas</label><div class="flex flex-wrap gap-2">${['Vazamento','Travado','Desgaste','Troca de peça','Ajuste','Limpeza','Quebrado','Ruído anormal'].map(tag=>`<button type="button" onclick="addTag('${tag}')" class="chip-tag text-xs px-3 py-1 rounded-full border border-gray-600 bg-secondary text-gray-300 hover:border-primary hover:text-primary">${tag}</button>`).join('')}</div></div>
      <button onclick="submitForm()" class="w-full btn-industrial bg-primary text-black py-4 mt-4">SALVAR</button>
    </div>`;
  };

  async function createHistoryRecord(line,valve,record,id) {
    const rid=id || record.id || `${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    const payload={...record,id:record.id||rid,line:String(line),valve:String(valve),createdAt:record.createdAt||isoNow(),updatedAt:isoNow()};
    delete payload.photos;
    await db.collection('lines').doc(String(line)).collection('valves').doc(String(valve)).set({valveNumber:valve==='GERAL'?0:Number(valve)},{merge:true});
    await historyRef(line,valve,rid).set(payload,{merge:true});
    return rid;
  }

  doSubmit = async function(crit) {
    const ts=isoNow(), base=Date.now();
    await Promise.all(state.selectedSubsets.map((sub,idx)=>createHistoryRecord(state.selectedLine,state.selectedValve,{
      id:`${base}-${idx}`,timestamp:ts,subset:sub,type:state.form.type,description:state.form.description,
      executante:state.form.name,turno:state.form.shift,status:'ok',isCritical:!!crit,source:'app'
    },`${base}-${idx}`)));
    if(state.form.type==='preventiva') await markPreventivePlanProgress(String(state.selectedLine),Number(state.selectedValve));
    showToast('Manutenções Salvas!','success'); state.form.description=''; state.form.photos=[]; state.selectedSubsets=[]; state.step='line'; render(false);
  };

  submitSonda = async function() {
    const obs=state.sondaForm.obs,op=state.sondaForm.op,t=state.form.shift;
    if(!obs||!op||!t) return showToast('Preencha todos os campos!','error');
    const typeRec=state.sondaAction==='jumper'?'sonda_event':'corretiva';
    const sondaStatus=state.sondaAction==='jumper'?'jumpeada':'ok';
    const id=Date.now().toString();
    await createHistoryRecord(state.selectedLine,state.selectedValve,{id,timestamp:isoNow(),subset:'SONDA',type:typeRec,description:`[SONDA] ${state.sondaAction.toUpperCase()}: ${obs} (Op: ${op}/${t})`,executante:op,turno:t,status:sondaStatus==='jumpeada'?'pendente':'ok',isSonda:true,isCritical:false,source:'app'},id);
    await db.collection('lines').doc(String(state.selectedLine)).collection('valves').doc(String(state.selectedValve)).set({valveNumber:Number(state.selectedValve),sonda_status:sondaStatus},{merge:true});
    state.sondaForm.obs=''; state.step='line'; showToast('Sonda Atualizada!','success'); render(false);
  };

  submitFalhaGeral = async function() {
    if(!state.form.name.trim()) return showToast('Preencha seu Nome!','error');
    if(!state.form.shift) return showToast('Selecione o Turno!','error');
    if(!state.form.falhaType) return showToast('Selecione o Tipo de Falha!','error');
    localStorage.setItem('sala_valvulas_nome',state.form.name); localStorage.setItem('sala_valvulas_turno',state.form.shift);
    const id=Date.now().toString();
    await createHistoryRecord(state.selectedLine,'GERAL',{id,timestamp:isoNow(),subset:'GERAL',type:'falha_geral',description:`[FALHA] ${state.form.falhaType}${state.form.description?' - '+state.form.description:''} (Exec: ${state.form.name}/${state.form.shift})`,executante:state.form.name,turno:state.form.shift,status:'ok',isCritical:false,source:'app'},id);
    state.form.description='';state.form.falhaType='';state.step='line';showToast('Falha Registrada!','success');render(false);
  };

  askDel = function(line,valve,id) {
    showPasswordPrompt(async()=>{
      let target=Object.values(historyDB).find(r=>String(r.line)===String(line)&&String(r.valve)===String(valve)&&(String(r.id)===String(id)||String(r.historyDocId)===String(id)));
      if(!target) return showToast('Registro não encontrado.','error');
      await db.doc(target.historyPath).delete(); showToast('Excluído!','success');
    });
  };

  // Histórico profissional
  function historyFromV2() { return Object.values(historyDB); }
  function legacyHistoryFlattened() {
    const out=[];
    CMMS_LINES.forEach(l=>Object.values(globalDB[l]||{}).forEach(v=>(v.historico||[]).forEach(h=>out.push({...h,line:l,valve:v.valveNumber,docId:v.docId}))));
    return out;
  }

  getFilteredData = function() {
    if(!historyV2Ready) return legacyGetFilteredData();
    const f=state.filters; let res=[];
    const search=(f.searchText||'').trim().toLowerCase(); const valve=(f.valve||'').trim().toUpperCase();
    historyFromV2().forEach(r=>{
      if(f.line!=='all'&&String(r.line)!==String(f.line)) return;
      if(valve && String(r.valve).toUpperCase()!==valve && `V${String(r.valve).toUpperCase()}`!==valve) return;
      if(f.historyType!=='all'){
        if(f.historyType==='sonda'&&r.subset!=='SONDA') return;
        else if(f.historyType==='falha_geral'&&r.type!=='falha_geral') return;
        else if(!['sonda','falha_geral'].includes(f.historyType)&&r.type!==f.historyType) return;
      }
      if(f.subset&&f.subset!=='all'&&String(r.subset)!==String(f.subset)) return;
      const day=String(r.timestamp||'').slice(0,10); if(f.startDate&&day<f.startDate)return; if(f.endDate&&day>f.endDate)return;
      if(search){const hay=`${r.line} ${r.valve} ${r.subset} ${r.type} ${r.description} ${r.executante} ${r.turno}`.toLowerCase(); if(!hay.includes(search))return;}
      res.push(r);
    });
    if(f.historyType==='ops_abertas'){
      Object.entries(opportunitiesDB).forEach(([line,ops])=>(ops||[]).forEach(o=>{
        if(f.line!=='all'&&line!==f.line)return;
        if(valve&&String(o.valvula)!==valve)return;
        res.push({id:o.id,timestamp:o.createdAt||isoNow(),line,valve:o.valvula,type:'oportunidade',subset:o.subset||'Geral',description:`PENDENTE: ${o.texto} - Solicitante: ${o.nome}`,isOp:true});
      }));
    }
    if((f.line==='all'||f.line==='Placas')&&(f.historyType==='all'||f.historyType==='placa_move')){
      Object.values(placasDB||{}).forEach(p=>(p.historico||[]).forEach(h=>{
        const plateName=String(p.nome||'');
        if(valve&&plateName.toUpperCase()!==valve)return;
        const day=String(h.timestamp||'').slice(0,10); if(f.startDate&&day<f.startDate)return; if(f.endDate&&day>f.endDate)return;
        const description=`Moveu ${h.qtd} un. de ${String(h.de||'').toUpperCase()} para ${String(h.para||'').toUpperCase()}${h.obs?' - '+h.obs:''} (Exec: ${h.executante||''})`;
        if(search&&!`${plateName} placas estoque ${description}`.toLowerCase().includes(search))return;
        res.push({id:h.id,timestamp:h.timestamp,line:'Placas',valve:plateName,type:'placa_move',subset:'Estoque',description,isPlaca:true});
      }));
    }
    res.sort((a,b)=>f.sort==='oldest'?new Date(a.timestamp)-new Date(b.timestamp):f.sort==='valve'?Number(a.valve)-Number(b.valve):new Date(b.timestamp)-new Date(a.timestamp));
    return res;
  };

  window.applyHistoryRange=function(kind){
    const now=new Date(); let s='',e='';
    const fmt=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if(kind==='month'){[s,e]=currentMonthBounds();}
    if(kind==='prev'){const d=new Date(now.getFullYear(),now.getMonth()-1,1);s=fmt(d);e=fmt(new Date(d.getFullYear(),d.getMonth()+1,0));}
    if(kind==='30'){e=fmt(now);const d=new Date(now);d.setDate(d.getDate()-29);s=fmt(d);}
    if(kind==='90'){e=fmt(now);const d=new Date(now);d.setDate(d.getDate()-89);s=fmt(d);}
    if(kind==='all'){s='';e='';}
    state.filters.startDate=s;state.filters.endDate=e;render(false);
  };

  window.setHistorySubset=function(v){state.filters.subset=v;render(false);};
  window.setHistorySort=function(v){state.filters.sort=v;render(false);};

  renderHistoryView = function(c) {
    const subsets=[...new Set(historyFromV2().map(r=>r.subset).filter(Boolean))].sort();
    c.innerHTML=`<div class="space-y-4 animate-pop-in">
      <div class="flex items-end justify-between gap-3"><div><div class="cmms-section-title">Consulta e manutenção dos registros</div><h2 class="text-2xl font-bold">Histórico</h2></div><span class="cmms-badge ${historyV2Ready?'ok':'warn'}">${historyV2Ready?'Histórico V2':'Modo legado'}</span></div>
      <div class="card-industrial p-4 space-y-3">
        <div><label class="label-industrial">Buscar</label><div class="relative"><i data-lucide="search" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500"></i><input class="input-industrial pl-10" placeholder="válvula, componente, vazamento..." value="${esc(state.filters.searchText)}" oninput="state.filters.searchText=this.value;loadHistory()"></div></div>
        <div class="flex gap-2 overflow-y-auto pb-1">${[['month','Este mês'],['prev','Mês passado'],['30','30 dias'],['90','90 dias'],['all','Tudo']].map(([k,l])=>`<button onclick="applyHistoryRange('${k}')" class="cmms-filter-chip">${l}</button>`).join('')}</div>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div><label class="label-industrial">Local</label><select class="input-industrial" onchange="state.filters.line=this.value;loadHistory()"><option value="all">Todas</option>${CMMS_LINES.map(l=>`<option value="${l}" ${state.filters.line===l?'selected':''}>L${l}</option>`).join('')}<option value="Placas" ${state.filters.line==='Placas'?'selected':''}>Placas</option></select></div>
          <div><label class="label-industrial">Tipo</label><select class="input-industrial" onchange="state.filters.historyType=this.value;loadHistory()"><option value="all">Todos</option><option value="preventiva">Preventiva</option><option value="corretiva">Corretiva</option><option value="inspecao">Inspeção</option><option value="sonda">Sonda</option><option value="falha_geral">Falhas Enchedora</option><option value="placa_move">Movimentação de Placas</option><option value="ops_abertas">OS abertas</option></select></div>
          <div><label class="label-industrial">Componente</label><select class="input-industrial" onchange="setHistorySubset(this.value)"><option value="all">Todos</option>${subsets.map(s=>`<option value="${esc(s)}" ${state.filters.subset===s?'selected':''}>${esc(s)}</option>`).join('')}</select></div>
          <div><label class="label-industrial">Válvula</label><input class="input-industrial" placeholder="Ex: 71" value="${esc(state.filters.valve)}" oninput="state.filters.valve=this.value;loadHistory()"></div>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div><label class="label-industrial">Início</label><input type="date" class="input-industrial" value="${esc(state.filters.startDate)}" onchange="state.filters.startDate=this.value;loadHistory()"></div>
          <div><label class="label-industrial">Fim</label><input type="date" class="input-industrial" value="${esc(state.filters.endDate)}" onchange="state.filters.endDate=this.value;loadHistory()"></div>
          <div><label class="label-industrial">Ordenar</label><select class="input-industrial" onchange="setHistorySort(this.value)"><option value="newest">Mais recentes</option><option value="oldest">Mais antigas</option><option value="valve">Válvula</option></select></div>
          <div class="flex items-end gap-2"><button onclick="exportData('excel')" class="btn-industrial bg-green-700 text-white flex-1 py-3 text-xs">Excel</button><button onclick="exportData('pdf')" class="btn-industrial bg-red-700 text-white flex-1 py-3 text-xs">PDF</button></div>
        </div>
      </div>
      <div id="history-summary"></div><div id="h-list" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 pb-24"></div>
    </div>`;
    loadHistory();
  };

  loadHistory = function() {
    const el=document.getElementById('h-list'); if(!el)return; const res=getFilteredData();
    const maint=res.filter(r=>!r.isOp&&!r.isPlaca); const prev=maint.filter(r=>r.type==='preventiva').length, corr=maint.filter(r=>r.type==='corretiva').length;
    const sm=document.getElementById('history-summary'); if(sm)sm.innerHTML=`<div class="cmms-grid-auto"><div class="cmms-kpi"><small>Encontrados</small><strong>${res.length}</strong></div><div class="cmms-kpi"><small>Corretivas</small><strong class="text-red-400">${corr}</strong></div><div class="cmms-kpi"><small>Preventivas</small><strong class="text-green-400">${prev}</strong></div></div>`;
    if(!res.length){el.innerHTML='<div class="cmms-empty col-span-full"><i data-lucide="search-x" class="w-8 h-8 mx-auto mb-2"></i>Nenhum registro com estes filtros.</div>';lucide.createIcons();return;}
    el.innerHTML=res.map(r=>{
      if(r.isOp)return `<div class="cmms-order-card border-yellow-500/20"><div class="flex justify-between"><strong>L${esc(r.line)}/V${esc(r.valve)}</strong><span class="cmms-badge warn">OS aberta</span></div><p class="text-sm text-gray-300 mt-2">${esc(r.description)}</p></div>`;
      const d=new Date(r.timestamp), isSonda=r.subset==='SONDA', isFalha=r.type==='falha_geral';
      return `<div class="cmms-order-card ${r.isCritical?'border-red-500/60':''}">
        <div class="flex justify-between gap-2"><div><strong class="font-mono text-primary">L${esc(r.line)}/${String(r.valve)==='GERAL'?'GERAL':'V'+esc(r.valve)}</strong><div class="text-[11px] text-gray-500 mt-1">${d.toLocaleDateString('pt-BR')} ${d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}</div></div>
        <div class="flex gap-2"><button onclick="openHistoryEdit('${esc(r.historyPath)}')" class="text-blue-400" title="Editar"><i data-lucide="pencil" class="w-4 h-4"></i></button><button onclick="askDel('${esc(r.line)}','${esc(r.valve)}','${esc(r.historyDocId||r.id)}')" class="text-red-500" title="Excluir"><i data-lucide="trash-2" class="w-4 h-4"></i></button></div></div>
        <div class="flex flex-wrap gap-2 mt-3"><span class="cmms-badge ${r.type==='corretiva'?'danger':r.type==='preventiva'?'ok':isSonda?'warn':''}">${esc(isFalha?'Falha Geral':r.type)}</span><span class="cmms-badge">${esc(r.subset||'Geral')}</span>${r.sapOrderId?`<span class="cmms-badge">SAP ${esc(r.sapOrderId)}</span>`:''}</div>
        <p class="text-sm text-gray-300 mt-3 leading-relaxed">${esc(r.description)}</p>${r.executante?`<div class="text-xs text-gray-500 mt-3">${esc(r.executante)}${r.turno?' · '+esc(r.turno):''}</div>`:''}
      </div>`;
    }).join(''); lucide.createIcons();
  };

  window.openHistoryEdit=function(path){
    const r=historyDB[path]; if(!r)return showToast('Registro não encontrado.','error');
    const line=String(r.line), subsets=(LINE_CONFIGS[line]?.subsets||['Geral']).concat(['Geral','SONDA','MC9','EA10']).filter((v,i,a)=>a.indexOf(v)===i);
    openModal('Editar registro',`<div class="space-y-3">
      <div class="grid grid-cols-2 gap-3"><div><label class="label-industrial">Linha</label><input class="input-industrial" value="L${esc(line)}" disabled></div><div><label class="label-industrial">Válvula</label><input class="input-industrial" value="${esc(r.valve)}" disabled></div></div>
      <div class="grid grid-cols-2 gap-3"><div><label class="label-industrial">Tipo</label><select id="ed-type" class="input-industrial"><option value="corretiva" ${r.type==='corretiva'?'selected':''}>Corretiva</option><option value="preventiva" ${r.type==='preventiva'?'selected':''}>Preventiva</option><option value="inspecao" ${r.type==='inspecao'?'selected':''}>Inspeção</option><option value="sonda_event" ${r.type==='sonda_event'?'selected':''}>Sonda</option><option value="falha_geral" ${r.type==='falha_geral'?'selected':''}>Falha Geral</option></select></div><div><label class="label-industrial">Componente</label><select id="ed-sub" class="input-industrial">${subsets.map(s=>`<option value="${esc(s)}" ${r.subset===s?'selected':''}>${esc(s)}</option>`).join('')}</select></div></div>
      <div><label class="label-industrial">Data / hora</label><input id="ed-time" type="datetime-local" class="input-industrial" value="${localDateInput(r.timestamp)}"></div>
      <div><label class="label-industrial">Descrição</label><textarea id="ed-desc" rows="4" class="input-industrial">${esc(r.description)}</textarea></div>
      <div class="grid grid-cols-2 gap-3"><div><label class="label-industrial">Responsável</label><input id="ed-exec" class="input-industrial" value="${esc(r.executante||'')}"></div><div><label class="label-industrial">Turno</label><select id="ed-turno" class="input-industrial"><option value="">-</option>${['Manhã','Tarde','Noite'].map(t=>`<option ${r.turno===t?'selected':''}>${t}</option>`).join('')}</select></div></div>
      ${r.notionPageId?'<div class="text-[11px] text-yellow-500/80">Registro originado do Notion. A edição altera o app; um reenvio futuro da mesma página pode substituir os campos.</div>':''}
      <button onclick="saveHistoryEdit('${esc(path)}')" class="btn-industrial bg-primary text-black w-full py-3">SALVAR ALTERAÇÃO</button>
    </div>`);
  };
  window.saveHistoryEdit=async function(path){
    const r=historyDB[path]; if(!r)return; const ref=db.doc(path);
    const patch={type:document.getElementById('ed-type').value,subset:document.getElementById('ed-sub').value,timestamp:toIsoFromLocal(document.getElementById('ed-time').value),description:document.getElementById('ed-desc').value.trim(),executante:document.getElementById('ed-exec').value.trim(),turno:document.getElementById('ed-turno').value,updatedAt:isoNow(),editedInApp:true};
    if(!patch.description)return showToast('Descrição não pode ficar vazia.','error');
    await ref.update(patch);closeModal();showToast('Registro atualizado.','success');
  };

  exportData = async function(fmt){
    if(!historyV2Ready) return legacyExportData(fmt);
    const data=getFilteredData().filter(r=>!r.isOp).map(r=>({Data:new Date(r.timestamp).toLocaleString('pt-BR'),Local:'L'+r.line,'Válvula':r.valve,Tipo:r.type,Item:r.subset||'Geral',Descrição:r.description,Responsável:r.executante||'',Turno:r.turno||'',OrdemSAP:r.sapOrderId||''}));
    if(!data.length)return showToast('Sem dados para exportar.','error');
    if(fmt==='excel'){const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(data),'Histórico');XLSX.writeFile(wb,`Historico_${monthKey()}.xlsx`);}
    else{const doc=new window.jspdf.jsPDF({orientation:'landscape'});doc.text('Sala de Válvulas - Histórico',14,14);doc.autoTable({startY:20,head:[Object.keys(data[0])],body:data.map(Object.values),styles:{fontSize:7}});doc.save(`Historico_${monthKey()}.pdf`);}
  };

  // OS profissional, mantendo oportunidades como fila aberta e work_orders como arquivo completo
  window.openOpModal=function(line){openWorkOrderCreate(line);};
  window.openWorkOrderCreate=function(line='512'){
    const subsets=(LINE_CONFIGS[line]?.subsets||['Geral']).concat(['Geral']).filter((v,i,a)=>a.indexOf(v)===i);
    openModal(`Nova OS L${line}`,`<div class="space-y-3">
      <div class="grid grid-cols-2 gap-3"><div><label class="label-industrial">Válvula</label><input id="wo-v" type="number" min="1" max="${MAX_VALVES[line]}" class="input-industrial"></div><div><label class="label-industrial">Componente</label><select id="wo-sub" class="input-industrial">${subsets.map(s=>`<option>${esc(s)}</option>`).join('')}</select></div></div>
      <div class="grid grid-cols-2 gap-3"><div><label class="label-industrial">Prioridade</label><select id="wo-pri" class="input-industrial"><option>Baixa</option><option selected>Normal</option><option>Alta</option><option>Crítica</option></select></div><div><label class="label-industrial">Prazo</label><input id="wo-due" type="date" class="input-industrial"></div></div>
      <div><label class="label-industrial">Responsável</label><input id="wo-name" class="input-industrial" value="${esc(state.form.name||'')}"></div>
      <div><label class="label-industrial">Problema / oportunidade</label><textarea id="wo-text" rows="3" class="input-industrial" placeholder="O que precisa ser feito?"></textarea></div>
      <button onclick="saveWorkOrder('${line}')" class="btn-industrial bg-primary text-black w-full py-3">CRIAR ORDEM DE SERVIÇO</button></div>`);
  };
  window.saveWorkOrder=async function(line){
    const v=Number(document.getElementById('wo-v').value),subset=document.getElementById('wo-sub').value,text=document.getElementById('wo-text').value.trim(),name=document.getElementById('wo-name').value.trim(),priority=document.getElementById('wo-pri').value,dueDate=document.getElementById('wo-due').value;
    if(!v||v<1||v>MAX_VALVES[line]||!text||!name)return showToast('Preencha válvula, responsável e descrição.','error');
    const ref=db.collection('oportunidades').doc(), created=isoNow(), osNumber=`OS-${created.slice(2,10).replaceAll('-','')}-${created.slice(11,19).replaceAll(':','')}`;
    const openData={linha:line,nome:name,turno:state.form.shift||'',texto:text,valvula:v,subset,priority,dueDate,status:'aberta',osNumber,createdAt:created};
    const batch=db.batch(); batch.set(ref,openData); batch.set(db.collection('work_orders').doc(ref.id),{...openData,source:'app',updatedAt:created}); await batch.commit();
    closeModal();showToast(`${osNumber} criada.`,'success');
  };
  window.startWorkOrder=async function(id){const t=isoNow();await Promise.all([db.collection('oportunidades').doc(id).update({status:'em_andamento',startedAt:t}),db.collection('work_orders').doc(id).set({status:'em_andamento',startedAt:t,updatedAt:t},{merge:true})]);showToast('OS iniciada.','success');};
  window.completeWorkOrderPrompt=function(id){const w=workOrdersDB[id]||(window._workOrderFallback||{})[id]||{};openModal('Concluir OS',`<div class="space-y-3"><p class="text-sm text-gray-300">${esc(w.osNumber||'OS')} · L${esc(w.linha)}/V${esc(w.valvula)}</p><input id="wo-done-by" class="input-industrial" placeholder="Quem executou?" value="${esc(state.form.name||'')}"><textarea id="wo-solution" class="input-industrial" rows="3" placeholder="Solução executada"></textarea><button onclick="completeWorkOrder('${id}')" class="btn-industrial bg-green-600 text-white w-full py-3">CONCLUIR</button></div>`);};
  window.completeWorkOrder=async function(id){
    const w=workOrdersDB[id]||(window._workOrderFallback||{})[id]||{},by=document.getElementById('wo-done-by').value.trim(),solution=document.getElementById('wo-solution').value.trim(); if(!by||!solution)return showToast('Informe executante e solução.','error');
    const done=isoNow(), started=w.startedAt||w.createdAt||done, recId=`wo-${id}`;
    await createHistoryRecord(w.linha,w.valvula,{id:recId,timestamp:done,subset:w.subset||'Geral',type:'corretiva',description:`[${w.osNumber||'OS'}] Defeito: ${w.texto} | Solução: ${solution}`,executante:by,turno:state.form.shift||w.turno||'',status:'ok',isCritical:w.priority==='Crítica',source:'work_order',workOrderId:id},recId);
    const batch=db.batch();batch.set(db.collection('work_orders').doc(id),{status:'concluida',solution,executante:by,startedAt:started,completedAt:done,updatedAt:done},{merge:true});batch.delete(db.collection('oportunidades').doc(id));await batch.commit();closeModal();showToast('OS concluída e histórico atualizado.','success');
  };
  doOpDone=async function(line,id,nome,turno,txt,valvula,subset){
    const fallback={linha:line,nome,turno,texto:txt,valvula:Number(valvula),subset:subset||'Geral',status:'aberta',createdAt:isoNow(),osNumber:`OS-LEG-${id.slice(0,6)}`};
    window._workOrderFallback=window._workOrderFallback||{}; window._workOrderFallback[id]=fallback;
    if(!workOrdersDB[id])await db.collection('work_orders').doc(id).set(fallback,{merge:true});
    completeWorkOrderPrompt(id);
  };
  askOpDone=function(line,id,nome,turno,texto,valvula,subset){doOpDone(line,id,nome,turno,texto,valvula,subset);};
  askDelOp=function(id){showPasswordPrompt(async()=>{const batch=db.batch();batch.delete(db.collection('oportunidades').doc(id));batch.set(db.collection('work_orders').doc(id),{status:'cancelada',cancelledAt:isoNow(),updatedAt:isoNow()},{merge:true});await batch.commit();showToast('OS cancelada.','success');});};

  function openWorkOrders(){return Object.values(workOrdersDB).filter(w=>!['concluida','cancelada'].includes(w.status));}
  function statusBadge(s){const map={aberta:['warn','Aberta'],em_andamento:['warn','Em andamento'],aguardando_material:['danger','Aguard. material'],concluida:['ok','Concluída'],cancelada:['','Cancelada']};const [c,l]=map[s]||['',s||'Aberta'];return `<span class="cmms-badge ${c}">${esc(l)}</span>`;}
  renderWorkOrdersView=function(c){
    const all=Object.values(workOrdersDB).sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0)); const open=all.filter(w=>!['concluida','cancelada'].includes(w.status));
    c.innerHTML=`<div class="space-y-4"><div class="flex justify-between items-end"><div><div class="cmms-section-title">Trabalho corretivo e oportunidades</div><h2 class="text-2xl font-bold">Ordens de Serviço</h2></div><button onclick="openWorkOrderCreate('512')" class="btn-industrial bg-primary text-black px-4 py-3 text-xs">+ Nova OS</button></div>
      <div class="cmms-grid-auto"><div class="cmms-kpi"><small>Abertas</small><strong>${open.length}</strong></div><div class="cmms-kpi"><small>Em andamento</small><strong>${all.filter(w=>w.status==='em_andamento').length}</strong></div><div class="cmms-kpi"><small>Concluídas</small><strong>${all.filter(w=>w.status==='concluida').length}</strong></div><div class="cmms-kpi"><small>Críticas abertas</small><strong class="text-red-400">${open.filter(w=>w.priority==='Crítica').length}</strong></div></div>
      <div class="flex gap-2">${CMMS_LINES.map(l=>`<button onclick="openWorkOrderCreate('${l}')" class="cmms-filter-chip">+ OS L${l}</button>`).join('')}</div>
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">${all.length?all.map(w=>`<div class="cmms-order-card"><div class="flex justify-between gap-2"><div><div class="text-xs text-gray-500">${esc(w.osNumber||w.id)}</div><strong>L${esc(w.linha)}/V${esc(w.valvula)} · ${esc(w.subset||'Geral')}</strong></div>${statusBadge(w.status)}</div><p class="text-sm text-gray-300 mt-3">${esc(w.texto||w.description||'')}</p><div class="flex justify-between items-center mt-3"><span class="cmms-badge ${w.priority==='Crítica'?'danger':w.priority==='Alta'?'warn':''}">${esc(w.priority||'Normal')}</span><div class="flex gap-2">${w.status==='aberta'?`<button onclick="startWorkOrder('${w.id}')" class="text-xs text-yellow-400">INICIAR</button>`:''}${!['concluida','cancelada'].includes(w.status)?`<button onclick="completeWorkOrderPrompt('${w.id}')" class="text-xs text-green-400">CONCLUIR</button>`:''}</div></div></div>`).join(''):'<div class="cmms-empty col-span-full">Nenhuma OS cadastrada.</div>'}</div></div>`;
  };

  // Ordens SAP + planejamento sequencial
  function latestPlanForLine(line){return Object.values(maintenancePlansDB).filter(p=>String(p.line)===String(line)).sort((a,b)=>String(b.month||'').localeCompare(String(a.month||'')))[0];}
  function makeSequence(line,start,count){const max=MAX_VALVES[line], arr=[];let n=start;for(let i=0;i<count;i++){arr.push(n);n++;if(n>max)n=1;}return arr;}
  function suggestedSequence(line,count=PLAN_TARGETS[line]){const last=latestPlanForLine(line);let start=last&&Array.isArray(last.valves)&&last.valves.length?Number(last.valves[last.valves.length-1])+1:1;if(start>MAX_VALVES[line])start=1;return makeSequence(line,start,count);}
  function planProgress(p){const done=new Set((p.completedValves||[]).map(Number)), total=(p.valves||[]).length;return {done:[...done].filter(v=>(p.valves||[]).map(Number).includes(v)).length,total};}
  window.openPlanModal=function(line='512'){
    const target=PLAN_TARGETS[line],seq=suggestedSequence(line,target); const sap=Object.values(sapOrdersDB).filter(o=>(!o.line||String(o.line)===line)&&(!o.month||o.month===monthKey())&&!['concluida','cancelada'].includes(o.status));
    openModal(`Planejar L${line}`,`<div class="space-y-3"><div class="grid grid-cols-2 gap-3"><div><label class="label-industrial">Mês</label><input id="pl-month" type="month" class="input-industrial" value="${monthKey()}"></div><div><label class="label-industrial">Quantidade alvo</label><input id="pl-count" type="number" class="input-industrial" value="${target}" min="1" max="${MAX_VALVES[line]}" oninput="previewPlan('${line}')"></div></div><div><label class="label-industrial">Primeira válvula</label><input id="pl-start" type="number" class="input-industrial" value="${seq[0]}" min="1" max="${MAX_VALVES[line]}" oninput="previewPlan('${line}')"></div><div id="pl-preview" class="p-3 rounded bg-secondary border border-gray-700 font-mono text-sm text-primary">${seq.map(v=>'V'+v).join(' · ')}</div>${sap.length?`<div><label class="label-industrial">Vincular ordens SAP</label><div class="space-y-2">${sap.map(o=>`<label class="flex gap-2 items-center text-sm"><input type="checkbox" class="pl-sap" value="${o.id}"><span>${esc(o.sapOrderNumber||o.id)} · ${currency(o.totalValue)}</span></label>`).join('')}</div></div>`:''}<button onclick="savePlan('${line}')" class="btn-industrial bg-primary text-black w-full py-3">SALVAR PROGRAMAÇÃO</button></div>`);
  };
  window.previewPlan=function(line){const st=Math.max(1,Number(document.getElementById('pl-start').value)||1),cnt=Math.max(1,Number(document.getElementById('pl-count').value)||PLAN_TARGETS[line]);document.getElementById('pl-preview').innerText=makeSequence(line,st,cnt).map(v=>'V'+v).join(' · ');};
  window.savePlan=async function(line){const month=document.getElementById('pl-month').value,count=Number(document.getElementById('pl-count').value),start=Number(document.getElementById('pl-start').value);if(!month||!count||!start)return showToast('Preencha mês, quantidade e início.','error');const valves=makeSequence(line,start,count),sapIds=[...document.querySelectorAll('.pl-sap:checked')].map(x=>x.value),id=`${month}-${line}`;await db.collection('maintenance_plans').doc(id).set({month,line,targetCount:count,startValve:valves[0],endValve:valves[valves.length-1],valves,completedValves:maintenancePlansDB[id]?.completedValves||[],linkedSapOrderIds:sapIds,status:'planejado',createdAt:maintenancePlansDB[id]?.createdAt||isoNow(),updatedAt:isoNow()},{merge:true});closeModal();showToast(`Plano L${line} salvo.`,'success');};
  async function markPreventivePlanProgress(line,valve){const candidates=Object.values(maintenancePlansDB).filter(p=>String(p.line)===line&&p.month===monthKey()&&(p.valves||[]).map(Number).includes(Number(valve)));for(const p of candidates){const ref=db.collection('maintenance_plans').doc(p.id),next=new Set((p.completedValves||[]).map(Number));next.add(Number(valve));const complete=next.size>=(p.valves||[]).length;await ref.update({completedValves:[...next],status:complete?'concluido':'em_andamento',updatedAt:isoNow()});}}

  window.openSapOrderManual=function(){openModal('Nova ordem SAP',`<div class="space-y-3"><div class="grid grid-cols-2 gap-3"><div><label class="label-industrial">Número SAP</label><input id="sap-num" class="input-industrial"></div><div><label class="label-industrial">Mês</label><input id="sap-month" type="month" class="input-industrial" value="${monthKey()}"></div></div><div class="grid grid-cols-2 gap-3"><div><label class="label-industrial">Linha</label><select id="sap-line" class="input-industrial">${CMMS_LINES.map(l=>`<option value="${l}">L${l}</option>`).join('')}</select></div><div><label class="label-industrial">Prazo</label><input id="sap-due" type="date" class="input-industrial"></div></div><div><label class="label-industrial">Descrição</label><textarea id="sap-desc" class="input-industrial" rows="3"></textarea></div><div><label class="label-industrial">Valor total materiais</label><input id="sap-value" type="number" step="0.01" class="input-industrial" value="0"></div><button onclick="saveSapOrderManual()" class="btn-industrial bg-primary text-black w-full py-3">SALVAR ORDEM</button><div class="text-[11px] text-gray-500">A importação detalhada de materiais será feita quando você enviar o arquivo/exportação real do SAP, pois as colunas precisam ser mapeadas com segurança.</div></div>`);};
  window.saveSapOrderManual=async function(){const num=document.getElementById('sap-num').value.trim(),month=document.getElementById('sap-month').value,line=document.getElementById('sap-line').value,desc=document.getElementById('sap-desc').value.trim(),dueDate=document.getElementById('sap-due').value,totalValue=Number(document.getElementById('sap-value').value)||0;if(!num||!month)return showToast('Número SAP e mês são obrigatórios.','error');await db.collection('sap_orders').doc(num.replaceAll('/','-')).set({sapOrderNumber:num,month,line,description:desc,dueDate,totalValue,status:'recebida',materials:[],source:'manual',createdAt:isoNow(),updatedAt:isoNow()},{merge:true});closeModal();showToast('Ordem SAP cadastrada.','success');};

  renderOrdersView=function(c){
    const plans=Object.values(maintenancePlansDB).sort((a,b)=>String(b.month).localeCompare(String(a.month)));const orders=Object.values(sapOrdersDB).sort((a,b)=>String(b.month).localeCompare(String(a.month)));const thisPlans=plans.filter(p=>p.month===monthKey());const total=orders.filter(o=>o.month===monthKey()).reduce((s,o)=>s+Number(o.totalValue||0),0);
    c.innerHTML=`<div class="space-y-4"><div class="flex justify-between items-end gap-3"><div><div class="cmms-section-title">SAP + sequência mandatória</div><h2 class="text-2xl font-bold">Ordens & Preventivas</h2></div><button onclick="openSapOrderManual()" class="btn-industrial bg-primary text-black px-4 py-3 text-xs">+ Ordem SAP</button></div>
      <div class="cmms-grid-auto"><div class="cmms-kpi"><small>Ordens SAP no mês</small><strong>${orders.filter(o=>o.month===monthKey()).length}</strong></div><div class="cmms-kpi"><small>Valor materiais</small><strong class="text-primary" style="font-size:1.2rem">${currency(total)}</strong></div><div class="cmms-kpi"><small>Planos do mês</small><strong>${thisPlans.length}</strong></div><div class="cmms-kpi"><small>Preventivas concluídas</small><strong>${historyFromV2().filter(h=>h.type==='preventiva'&&String(h.timestamp).startsWith(monthKey())).length}</strong></div></div>
      <div class="card-industrial p-4"><div class="flex justify-between items-center mb-3"><div><div class="cmms-section-title mb-1">Sequência automática</div><div class="text-sm text-gray-400">A sugestão continua da última válvula programada e reinicia em V1 após fechar a enchedora. Quantidades padrão: L512 14, L513 14, L514 10.</div></div></div><div class="grid grid-cols-1 md:grid-cols-3 gap-3">${CMMS_LINES.map(l=>{const seq=suggestedSequence(l);return `<div class="cmms-order-card"><div class="flex justify-between"><strong>L${l}</strong><span class="cmms-badge">${PLAN_TARGETS[l]} válvulas</span></div><div class="font-mono text-xs text-primary mt-2">Próxima sugestão: V${seq[0]} → V${seq[seq.length-1]}${seq.includes(1)&&seq[0]!==1?' (vira ciclo)':''}</div><button onclick="openPlanModal('${l}')" class="btn-industrial bg-secondary border border-gray-700 w-full py-2 mt-3 text-xs">PROGRAMAR MÊS</button></div>`}).join('')}</div></div>
      <div><div class="cmms-section-title">Programação</div><div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">${plans.length?plans.map(p=>{const pr=planProgress(p),pct=pr.total?Math.round(pr.done/pr.total*100):0;return `<div class="cmms-order-card"><div class="flex justify-between"><div><div class="text-xs text-gray-500">${monthLabel(p.month)}</div><strong>L${p.line} · ${p.targetCount||pr.total} válvulas</strong></div>${statusBadge(p.status==='concluido'?'concluida':p.status==='em_andamento'?'em_andamento':'aberta')}</div><div class="text-xs font-mono text-gray-400 mt-3">${(p.valves||[]).map(v=>'V'+v).join(' · ')}</div><div class="flex justify-between text-xs mt-3"><span>${pr.done}/${pr.total}</span><span>${pct}%</span></div><div class="cmms-bar mt-1"><span style="width:${pct}%"></span></div></div>`}).join(''):'<div class="cmms-empty col-span-full">Nenhuma programação criada.</div>'}</div></div>
      <div><div class="cmms-section-title">Ordens SAP de válvulas</div><div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">${orders.length?orders.map(o=>`<div class="cmms-order-card"><div class="flex justify-between"><div><div class="text-xs text-gray-500">${esc(o.month||'-')}</div><strong>${esc(o.sapOrderNumber||o.id)}</strong></div>${statusBadge(o.status==='concluida'?'concluida':'aberta')}</div><p class="text-sm text-gray-300 mt-3">${esc(o.description||'')}</p><div class="flex justify-between mt-3"><span class="cmms-badge">${o.line?'L'+esc(o.line):'Linha não definida'}</span><strong class="text-primary">${currency(o.totalValue)}</strong></div>${Array.isArray(o.materials)&&o.materials.length?`<div class="text-xs text-gray-500 mt-2">${o.materials.length} materiais</div>`:''}</div>`).join(''):'<div class="cmms-empty col-span-full">Nenhuma ordem SAP importada ainda. Quando você enviar a exportação do SAP no chat, ela poderá ser filtrada e cadastrada neste módulo.</div>'}</div></div>
    </div>`;
  };

  // Indicadores
  function recentHistory(days=30){const min=Date.now()-days*86400000;return historyFromV2().filter(h=>new Date(h.timestamp).getTime()>=min);}
  function recurrenceAlerts(){const groups={};recentHistory(30).filter(h=>h.type==='corretiva').forEach(h=>{const k=`${h.line}/${h.valve}/${h.subset}`;(groups[k] ||= []).push(h);});return Object.entries(groups).filter(([,a])=>a.length>=3).sort((a,b)=>b[1].length-a[1].length);}
  function mtbfDays(){const byValve={};historyFromV2().filter(h=>h.type==='corretiva'&&h.valve!=='GERAL').forEach(h=>(byValve[`${h.line}/${h.valve}`] ||= []).push(new Date(h.timestamp).getTime()));let gaps=[];Object.values(byValve).forEach(a=>{a.sort((x,y)=>x-y);for(let i=1;i<a.length;i++)gaps.push((a[i]-a[i-1])/86400000);});return gaps.length?gaps.reduce((a,b)=>a+b,0)/gaps.length:null;}
  function mttrMinutes(){const vals=Object.values(workOrdersDB).filter(w=>w.status==='concluida'&&w.startedAt&&w.completedAt).map(w=>(new Date(w.completedAt)-new Date(w.startedAt))/60000).filter(v=>v>=0);return vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:null;}
  function pareto(items,keyFn,limit=6){const m={};items.forEach(x=>{const k=keyFn(x)||'-';m[k]=(m[k]||0)+1;});return Object.entries(m).sort((a,b)=>b[1]-a[1]).slice(0,limit);}
  function barList(rows){const max=rows[0]?.[1]||1;return rows.length?rows.map(([k,v])=>`<div class="mb-3"><div class="flex justify-between text-xs mb-1"><span>${esc(k)}</span><strong>${v}</strong></div><div class="cmms-bar"><span style="width:${Math.round(v/max*100)}%"></span></div></div>`).join(''):'<div class="text-sm text-gray-500">Sem dados suficientes.</div>';}
  function buildAlerts(){const alerts=[];Object.values(sapOrdersDB).forEach(o=>{if(o.dueDate&&!['concluida','cancelada'].includes(o.status)){const days=Math.ceil((new Date(o.dueDate+'T23:59:59')-new Date())/86400000);if(days<=7)alerts.push({level:days<0?'danger':'warn',icon:'calendar-clock',text:`SAP ${o.sapOrderNumber||o.id}: ${days<0?Math.abs(days)+' dia(s) atrasada':days+' dia(s) para o prazo'}`});}});openWorkOrders().forEach(w=>{if(w.priority==='Crítica'||w.priority==='Alta')alerts.push({level:w.priority==='Crítica'?'danger':'warn',icon:'triangle-alert',text:`${w.osNumber||'OS'} L${w.linha}/V${w.valvula}: ${w.priority}`});});CMMS_LINES.forEach(l=>Object.values(globalDB[l]||{}).filter(v=>v.sonda_status==='jumpeada').forEach(v=>alerts.push({level:'warn',icon:'zap',text:`L${l}/V${v.valveNumber} continua jumpeada`})));recurrenceAlerts().forEach(([k,a])=>alerts.push({level:'danger',icon:'repeat-2',text:`${k.replaceAll('/',' · ')}: ${a.length} corretivas em 30 dias`}));return alerts;}
  function refreshAlertCount(){const n=buildAlerts().length,el=document.getElementById('alert-count');if(!el)return;if(n){el.textContent=n>99?'99+':n;el.classList.remove('hidden');el.classList.add('flex');}else{el.classList.add('hidden');el.classList.remove('flex');}}
  window.openAlerts=function(){const a=buildAlerts();openModal('Central de Alertas',a.length?`<div class="space-y-2">${a.map(x=>`<div class="cmms-alert"><i data-lucide="${x.icon}" class="w-5 h-5 ${x.level==='danger'?'text-red-400':'text-yellow-400'}"></i><div class="text-sm text-gray-300">${esc(x.text)}</div></div>`).join('')}</div>`:'<div class="cmms-empty">Nenhum alerta importante agora.</div>');};
  renderDashboardView=function(c){const [start,end]=currentMonthBounds();const monthHist=historyFromV2().filter(h=>{const d=String(h.timestamp).slice(0,10);return d>=start&&d<=end;});const corr=monthHist.filter(h=>h.type==='corretiva'),prev=monthHist.filter(h=>h.type==='preventiva'),open=openWorkOrders(),sap=Object.values(sapOrdersDB).filter(o=>o.month===monthKey()&&!['concluida','cancelada'].includes(o.status)),jumpered=CMMS_LINES.reduce((n,l)=>n+Object.values(globalDB[l]||{}).filter(v=>v.sonda_status==='jumpeada').length,0),cost=Object.values(sapOrdersDB).filter(o=>o.month===monthKey()).reduce((s,o)=>s+Number(o.totalValue||0),0),mtbf=mtbfDays(),mttr=mttrMinutes(),recur=recurrenceAlerts();
    c.innerHTML=`<div class="space-y-4"><div><div class="cmms-section-title">Visão técnica e PCM</div><h2 class="text-2xl font-bold">Indicadores</h2></div><div class="cmms-grid-auto"><div class="cmms-kpi"><small>Corretivas no mês</small><strong class="text-red-400">${corr.length}</strong></div><div class="cmms-kpi"><small>Preventivas no mês</small><strong class="text-green-400">${prev.length}</strong></div><div class="cmms-kpi"><small>OS abertas</small><strong>${open.length}</strong></div><div class="cmms-kpi"><small>SAP pendentes</small><strong>${sap.length}</strong></div><div class="cmms-kpi"><small>Sondas jumpeadas</small><strong class="text-yellow-400">${jumpered}</strong></div><div class="cmms-kpi"><small>Materiais SAP no mês</small><strong class="text-primary" style="font-size:1.1rem">${currency(cost)}</strong></div><div class="cmms-kpi"><small>MTBF estimado</small><strong style="font-size:1.25rem">${mtbf==null?'-':mtbf.toFixed(1)+' d'}</strong></div><div class="cmms-kpi"><small>MTTR OS</small><strong style="font-size:1.25rem">${mttr==null?'-':mttr<60?Math.round(mttr)+' min':(mttr/60).toFixed(1)+' h'}</strong></div></div>
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4"><div class="card-industrial p-4"><div class="cmms-section-title">Pareto · válvulas corretivas</div>${barList(pareto(corr,h=>`L${h.line}/V${h.valve}`))}</div><div class="card-industrial p-4"><div class="cmms-section-title">Pareto · componentes</div>${barList(pareto(corr,h=>h.subset))}</div></div>
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4"><div class="card-industrial p-4"><div class="cmms-section-title">Reincidências · 30 dias</div>${recur.length?recur.slice(0,8).map(([k,a])=>`<div class="cmms-alert mb-2"><i data-lucide="repeat-2" class="w-5 h-5 text-red-400"></i><div><strong class="text-sm">${esc(k.replaceAll('/',' · '))}</strong><div class="text-xs text-gray-500">${a.length} corretivas</div></div></div>`).join(''):'<div class="text-sm text-gray-500">Sem reincidências com 3 ou mais corretivas nos últimos 30 dias.</div>'}</div><div class="card-industrial p-4"><div class="cmms-section-title">Alertas ativos</div>${buildAlerts().slice(0,8).map(x=>`<div class="cmms-alert mb-2"><i data-lucide="${x.icon}" class="w-5 h-5 ${x.level==='danger'?'text-red-400':'text-yellow-400'}"></i><div class="text-sm text-gray-300">${esc(x.text)}</div></div>`).join('')||'<div class="text-sm text-gray-500">Tudo tranquilo.</div>'}</div></div></div>`;
  };

  // Busca global
  window.openGlobalSearch=function(){let ov=document.getElementById('cmms-search-overlay');if(ov)ov.remove();ov=document.createElement('div');ov.id='cmms-search-overlay';ov.className='cmms-search-overlay';ov.innerHTML=`<div class="cmms-search-panel"><div class="flex gap-2"><div class="relative flex-1"><i data-lucide="search" class="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500"></i><input id="cmms-global-q" class="input-industrial pl-10" autofocus placeholder="Buscar V71, MC9, vazamento, SAP..."></div><button onclick="document.getElementById('cmms-search-overlay').remove()" class="px-3 text-gray-400"><i data-lucide="x"></i></button></div><div id="cmms-global-results" class="space-y-2 mt-4"></div></div>`;document.body.appendChild(ov);const inp=document.getElementById('cmms-global-q');inp.addEventListener('input',()=>renderGlobalSearch(inp.value));setTimeout(()=>inp.focus(),50);lucide.createIcons();};
  function renderGlobalSearch(q){const el=document.getElementById('cmms-global-results');if(!el)return;const s=q.trim().toLowerCase();if(s.length<2){el.innerHTML='<div class="cmms-empty">Digite pelo menos 2 caracteres.</div>';return;}const rows=[];historyFromV2().filter(h=>`${h.line} ${h.valve} ${h.subset} ${h.description}`.toLowerCase().includes(s)).slice(0,12).forEach(h=>rows.push({icon:'history',title:`L${h.line}/V${h.valve} · ${h.subset}`,sub:h.description,mode:'history'}));Object.values(workOrdersDB).filter(w=>`${w.osNumber} ${w.linha} ${w.valvula} ${w.subset} ${w.texto}`.toLowerCase().includes(s)).slice(0,6).forEach(w=>rows.push({icon:'list-checks',title:`${w.osNumber||'OS'} · L${w.linha}/V${w.valvula}`,sub:w.texto,mode:'workorders'}));Object.values(sapOrdersDB).filter(o=>`${o.sapOrderNumber} ${o.description} ${o.line}`.toLowerCase().includes(s)).slice(0,6).forEach(o=>rows.push({icon:'clipboard-list',title:`SAP ${o.sapOrderNumber}`,sub:o.description,mode:'orders'}));el.innerHTML=rows.length?rows.map(r=>`<button onclick="document.getElementById('cmms-search-overlay').remove();setMode('${r.mode}')" class="w-full text-left cmms-order-card flex gap-3"><i data-lucide="${r.icon}" class="w-5 h-5 text-primary"></i><div><strong class="text-sm">${esc(r.title)}</strong><div class="text-xs text-gray-500 line-clamp-2">${esc(r.sub)}</div></div></button>`).join(''):'<div class="cmms-empty">Nada encontrado.</div>';lucide.createIcons();}

  openManual = function(){
    openModal('Manual do Usuário', `<div class="space-y-5 text-sm text-gray-300">
      <div><h4 class="text-primary font-bold uppercase mb-2">Navegação</h4><p>A barra inferior organiza o sistema em <strong>Registro</strong>, <strong>Ordens</strong>, <strong>OS</strong>, <strong>Histórico</strong> e <strong>Indicadores</strong>.</p></div>
      <div><h4 class="text-primary font-bold uppercase mb-2">Registro</h4><p>Escolha linha, válvula e componente. Corretivas e preventivas são gravadas como documentos individuais. Preventivas continuam usando a senha administrativa 0608.</p></div>
      <div><h4 class="text-primary font-bold uppercase mb-2">Histórico</h4><p>Use busca, linha, tipo, componente, válvula e período. Os atalhos Este mês / Mês passado / 30 dias / 90 dias facilitam contagens. O lápis edita o registro atual e a lixeira exclui com senha.</p></div>
      <div><h4 class="text-primary font-bold uppercase mb-2">Ordens & Preventivas</h4><p>Cadastre ou importe ordens SAP e crie a programação mensal sequencial. Padrão: L512 14 válvulas, L513 14 e L514 10. A sequência continua da última válvula programada e reinicia em V1 ao completar a enchedora.</p></div>
      <div><h4 class="text-primary font-bold uppercase mb-2">Ordens de Serviço</h4><p>Oportunidades viraram OS. É possível definir prioridade, iniciar e concluir. Ao concluir, a solução gera automaticamente uma corretiva no histórico.</p></div>
      <div><h4 class="text-primary font-bold uppercase mb-2">Indicadores e alertas</h4><p>O painel mostra corretivas, preventivas, SAP, OS, jumpeadas, custos, Pareto, reincidência, MTBF e MTTR. O sino reúne alertas de prazo, criticidade, jumper e reincidência.</p></div>
      <div class="text-xs text-gray-500">A busca global fica na lupa do cabeçalho. O app também está preparado como PWA instalável pelo navegador.</div>
    </div>`);
  };

  // Inicialização
  enhanceShell(); startV2Listeners(); cmmsLoaded=true; render(false);
  console.info(`Sala de Válvulas CMMS v${APP_VERSION}`);
})();
