# coding: utf-8
"""Extracao de eventos tecnicos MINIMIZADOS, leitura exclusiva do Firestore.
Nao publicar descricoes, nomes, fotos nem identificadores pessoais.
"""
import os,json,re,hashlib,time,requests
from pathlib import Path
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from concurrent.futures import ThreadPoolExecutor
from collections import Counter,defaultdict

KEY=os.environ["FIREBASE_KEY"]
PROJ=os.environ.get("FIREBASE_PROJ","sala-valvulas-ow-163b3")
BASE=f"https://firestore.googleapis.com/v1/projects/{PROJ}/databases/(default)/documents"
TZ=ZoneInfo("America/Sao_Paulo")
START="2026-01-01";END="2026-10-13"
OUT="recurrence_firebase_data.json"
LINES=("512","513","514")

def request(path,**params):
    for attempt in range(4):
        try:
            rr=requests.get(f"{BASE}/{path}",params=dict(key=KEY,**params),timeout=35)
            if rr.status_code==404:return None
            if rr.status_code in (429,500,502,503,504) and attempt<3:
                time.sleep(1+attempt*2);continue
            rr.raise_for_status();return rr.json()
        except (requests.Timeout,requests.ConnectionError):
            if attempt==3:raise
            time.sleep(2+attempt)
def coll(path):
    result=[];cursor=None
    while True:
        kw={"pageSize":300}
        if cursor: kw["pageToken"]=cursor
        b=request(path,**kw)
        if not b:return result
        result+=b.get("documents",[])
        cursor=b.get("nextPageToken")
        if not cursor:return result

def value(v):
    if not isinstance(v,dict):return None
    for f in ("stringValue","timestampValue","integerValue","doubleValue","booleanValue"):
        if f in v:return v[f]
    if "arrayValue" in v:return [value(x) for x in v["arrayValue"].get("values",[])]
    if "mapValue" in v:return {k:value(x) for k,x in v["mapValue"].get("fields",{}).items()}
    return None
def decode(doc):
    return {k:value(v) for k,v in doc.get("fields",{}).items()}
def day(iso):
    if not iso:return ""
    try:
        z=datetime.fromisoformat(str(iso).replace("Z","+00:00"))
        if z.tzinfo is None:z=z.replace(tzinfo=TZ)
        return z.astimezone(TZ).date().isoformat()
    except (ValueError,TypeError):
        m=re.search(r"\d{4}-\d{2}-\d{2}",str(iso))
        return m.group(0) if m else ""
def normalize(s):
    return str(s or "").strip().upper()

def components(subset,description):
    """Componentes de acionamento: nao imputar diafragma sem mencao explicita."""
    s=normalize(subset);d=normalize(description)
    text=d
    explicit=set(re.findall(r"\bV([348])\b",text))
    subtype=re.search(r"\bV([348])\b",s)
    # O historico contem registros antigos V4 com subset incorreto "Acionamento V3".
    if subtype and s in ("V3","V4","V8","ACIONAMENTO V3","ACIONAMENTO V4","ACIONAMENTO V8"):
        explicit.add(subtype.group(1))
        # Se o texto nomeia exclusivamente outra V, prepondera o texto sobre rotulo
        vset=set(re.findall(r"\bV([348])\b",text))
        if vset and subtype.group(1) not in vset and ("ACIONAMENTO" in text or "TUCHO" in text):
            explicit=vset
    return sorted("V"+x for x in explicit)

def classify(d,subset,typ,status):
    text=normalize(d)
    is_jumper=("JUMPER" in text or "JUMPE" in text or normalize(subset) in ("SONDA","JUMPER") and typ=="sonda_event")
    mentions_diaphragm=bool(re.search(r"\bDIAFRAGM[AAOS]*\b|\bMEMBRAN[AAOS]*\b",text))
    mentions_quality=bool(re.search(r"QUALIDADE|DEFEIT|FORNECED|LOTE DE PE[CÇ]A|FALHA PRECOCE",text))
    # Um registro pendente com mera deteccao nao equivale a manutencao executada.
    has_action=bool(re.search(r"TROC|SUBSTIT|AJUST|INSTAL|RETIR|REMOV|REPAR|DESOBSTR|LIMP|NORMALIZ|ATUA[CÇ]|DESMONT|TAMPOU|CORRIG|TROUX|JUMPE",text))
    is_diagnostic_pending=(status=="pendente" and not has_action and typ=="corretiva")
    return is_jumper,mentions_diaphragm,mentions_quality,is_diagnostic_pending

def main():
    parents={l:coll(f"lines/{l}/valves") for l in LINES}
    jobs=[]
    with ThreadPoolExecutor(max_workers=12) as pool:
        for l,docs in parents.items():
            for doc in docs:
                valve=doc["name"].split("/")[-1]
                jobs.append((l,valve,pool.submit(coll,f"lines/{l}/valves/{valve}/history")))
        batches=[(l,v,fu.result()) for l,v,fu in jobs]
    events=[]
    types=defaultdict(Counter); perline=defaultdict(Counter)
    for l,v,docs in batches:
        for doc in docs:
            f=decode(doc)
            t=str(f.get("type") or "").lower()
            status=str(f.get("status") or "").lower()
            dt=day(f.get("timestamp"))
            if not dt or not(START<=dt<=END): continue
            types[l][t]+=1
            if t not in ("corretiva","sonda_event"):continue
            desc=str(f.get("description") or "")
            subset=str(f.get("subset") or "Geral")
            jumper,diaphragm,quality,pending_only=classify(desc,subset,t,status)
            notion=f.get("notionPageId")
            ident=doc["name"].split("/")[-1]
            events.append({
                "line":l,
                "valve":v,
                "date":dt,
                "type":t,
                "component":subset,
                "keyComponents":components(subset,desc),
                "status":status,
                "source":"notion" if notion else str(f.get("source") or "indefinido"),
                "jumper":jumper,
                "diaphragmMention":diaphragm,
                "qualityMention":quality,
                "diagnosticPending":pending_only,
                "notionId":notion or None,
                "eventKey":hashlib.sha256((l+"/"+v+"/"+str(ident)).encode()).hexdigest()[:12]
            })
    events.sort(key=lambda x:(x["line"],x["date"],int(x["valve"]) if x["valve"].isdigit() else 9999,x["component"]))
    selected=[x for x in events if not x["diagnosticPending"]]
    overview={}
    for line in LINES:
        raw=[x for x in events if x["line"]==line]
        sel=[x for x in selected if x["line"]==line]
        vt=defaultdict(set);vc=defaultdict(Counter);component_days=defaultdict(set)
        for e in sel:
            vt[e["valve"]].add(e["date"]);vc[e["valve"]][e["type"]]+=1
            component_days[(e["valve"],e["component"])].add(e["date"])
        overview[line]={
            "total_all_history_types":dict(types[line]),
            "selected_records":len(sel),
            "excluded_pending_diagnostics":len(raw)-len(sel),
            "valves_with_selected_events":len(vt),
            "recurrent_valves":sum(len(x)>=2 for x in vt.values()),
            "repeated_same_component_valves":len({v for (v,c),ds in component_days.items() if len(ds)>=2}),
            "sonda_events":sum(e["type"]=="sonda_event" for e in sel),
            "diaphragm_mentions":sum(e["diaphragmMention"] for e in sel),
        }
    result={"status":"verified","capturedAt":datetime.now(timezone.utc).isoformat(),"period":{"start":START,"end":END},"definitions":{
      "recurrence":">=2 dias distintos com registros de corretiva ou sonda_event por valvula.",
      "records":"Um registro por subconjunto; nao equivalem necessariamente a intervencoes distintas.",
      "pending":"Corretivas pendentes sem verbo de acao foram excluidas do indicador principal mas mantidas na base com diagnosticPending=true.",
      "diaphragm":"Cita explicitamente diafragma/membrana no texto original; demais atuacoes V3/V4/V8 nao confirmam defeito do diafragma."
    },"overview":overview,"events":events}
    Path(OUT).write_text(json.dumps(result,ensure_ascii=False,separators=(",",":"))+"\n",encoding="utf-8")
    print("AUDIT",json.dumps({l:overview[l] for l in LINES},ensure_ascii=False))
if __name__=="__main__":
    try:main()
    except Exception as e:
        Path(OUT).write_text(json.dumps({"status":"failed","error":str(e)[:300]}),encoding="utf-8")
        raise
