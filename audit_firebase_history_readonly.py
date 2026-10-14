# coding: utf-8
"""Auditoria somente-leitura do histórico Firestore V2.
Não grava nem altera documentos Firebase. Exclui observações, nomes e fotos.
"""
import os, json, time, re
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from pathlib import Path
import requests

KEY=os.environ["FIREBASE_KEY"]
PROJ=os.environ.get("FIREBASE_PROJ", "sala-valvulas-ow-163b3")
ROOT=f"https://firestore.googleapis.com/v1/projects/{PROJ}/databases/(default)/documents"
TZ=ZoneInfo("America/Sao_Paulo")
LINES=("512","513","514")
OUTPUT="firebase_history_audit_status.json"

def get(path, **params):
    url=f"{ROOT}/{path}"
    p={"key":KEY, **params}
    for attempt in range(4):
        try:
            r=requests.get(url,params=p,timeout=35)
            if r.status_code==404: return None
            if r.status_code in (429,500,502,503,504) and attempt<3:
                time.sleep(1.5*(attempt+1)); continue
            r.raise_for_status()
            return r.json()
        except (requests.Timeout, requests.ConnectionError):
            if attempt==3: raise
            time.sleep(1.5*(attempt+1))
    raise RuntimeError("Falha após tentativas")

def collection(path, page_size=300):
    docs=[];token=None
    while True:
        params={"pageSize":page_size}
        if token: params["pageToken"]=token
        result=get(path,**params)
        if result is None: return docs
        docs.extend(result.get("documents",[]))
        token=result.get("nextPageToken")
        if not token: return docs

def fv(o):
    if not isinstance(o,dict): return None
    if "stringValue" in o: return o["stringValue"]
    if "integerValue" in o: return int(o["integerValue"])
    if "doubleValue" in o: return float(o["doubleValue"])
    if "booleanValue" in o: return bool(o["booleanValue"])
    if "timestampValue" in o: return o["timestampValue"]
    if "arrayValue" in o: return [fv(x) for x in o["arrayValue"].get("values",[])]
    if "mapValue" in o: return {k:fv(v) for k,v in o["mapValue"].get("fields",{}).items()}
    return None

def decode(document):
    return {k:fv(v) for k,v in document.get("fields",{}).items()}

def local_day(t):
    if not t:return "sem-data"
    if isinstance(t,str):
        try:
            dt=datetime.fromisoformat(t.replace("Z","+00:00"))
            if dt.tzinfo is None: dt=dt.replace(tzinfo=TZ)
            return dt.astimezone(TZ).date().isoformat()
        except (TypeError,ValueError):
            m=re.search(r"\d{4}-\d{2}-\d{2}",t)
            return m.group(0) if m else "sem-data"
    return "sem-data"

def main():
    generated=datetime.now(timezone.utc).isoformat()
    marker=get("system/history_v2")
    parents={}
    for line in LINES:
        parents[line]=collection(f"lines/{line}/valves",300)
    jobs=[]
    with ThreadPoolExecutor(max_workers=14) as pool:
        for line, docs in parents.items():
            for d in docs:
                valve=d["name"].split("/")[-1]
                jobs.append((line,valve,pool.submit(collection,f"lines/{line}/valves/{valve}/history",300)))
        vals=[]
        for line,valve,future in jobs:
            vals.append((line,valve,future.result()))
    results={}
    total=Counter()
    for line in LINES:
        parent_count=len(parents[line])
        valves=[]
        line_types=Counter(); sources=Counter(); statuses=Counter(); total_docs=0
        for ln,v,docs in vals:
            if ln!=line:continue
            events=[decode(doc) for doc in docs]
            event_types=Counter(str(e.get("type") or "indefinido").lower() for e in events)
            total_docs+=len(events)
            line_types.update(event_types)
            srcs=Counter("notion" if e.get("notionPageId") else str(e.get("source") or "indefinido") for e in events)
            sources.update(srcs)
            statuses.update(str(e.get("status") or "indefinido") for e in events)
            correct=[e for e in events if str(e.get("type") or "").lower() in {"corretiva","corrective"}]
            corr_days=sorted(set(local_day(e.get("timestamp")) for e in correct if local_day(e.get("timestamp"))!="sem-data"))
            subset_days=defaultdict(set)
            for e in correct:
                subset=str(e.get("subset") or "Geral")
                day=local_day(e.get("timestamp"))
                if day!="sem-data":subset_days[subset].add(day)
            multi_subsets={s:len(days) for s,days in sorted(subset_days.items()) if len(days)>=2}
            if not events: continue
            all_days=sorted(set(local_day(e.get("timestamp")) for e in events if local_day(e.get("timestamp"))!="sem-data"))
            valves.append({
                "valve":v,
                "history_count":len(events),
                "type_counts":dict(event_types),
                "corrective_records":len(correct),
                "corrective_distinct_days":len(corr_days),
                "corrective_dates":corr_days,
                "subsets_repeating_different_days":multi_subsets,
                "corrective_subsets":dict(Counter(str(e.get("subset") or "Geral") for e in correct)),
                "sources":dict(srcs),
                "statuses":dict(Counter(str(e.get("status") or "indefinido") for e in events)),
                "first_history_date":all_days[0] if all_days else None,
                "last_history_date":all_days[-1] if all_days else None
            })
        valves.sort(key=lambda x:(-x["corrective_distinct_days"],-x["corrective_records"],int(x["valve"]) if x["valve"].isdigit() else 9999))
        results[line]={
            "valve_documents":parent_count,
            "valves_with_history":len(valves),
            "history_documents":total_docs,
            "type_counts":dict(line_types),
            "source_counts":dict(sources),
            "status_counts":dict(statuses),
            "valves_with_corrective":sum(x["corrective_records"]>0 for x in valves),
            "recurrent_valves_multiple_corrective_days":sum(x["corrective_distinct_days"]>=2 for x in valves),
            "valves":valves
        }
        total.update({"history_documents":total_docs,"corrective_documents":line_types.get("corretiva",0),"recurrent_valves":results[line]["recurrent_valves_multiple_corrective_days"]})
    out={
       "status":"verified",
       "generatedAt":generated,
       "data_origin":"Firebase Firestore em leitura direta via GitHub Actions",
       "method":"Uma válvula é recorrente quando apresenta corretivas em >=2 datas locais distintas. Subconjuntos são tratados separadamente. Não infere falha idêntica.",
       "firebase_marker": {k:v for k,v in decode(marker or {}).items() if k in ("completed","schemaVersion","completedAt","historyDocuments","legacyHistoryItems","line512","line513","line514")},
       "total":dict(total),
       "lines":results,
       "privacy":"Resumo técnico sem descrições, nomes, executantes ou fotos. Nenhuma escrita no Firebase."
    }
    Path(OUTPUT).write_text(json.dumps(out,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print("VERIFIED",json.dumps({k:{a:b for a,b in v.items() if a!="valves"} for k,v in results.items()},ensure_ascii=False))
if __name__=="__main__":
    try:main()
    except Exception as exc:
        Path(OUTPUT).write_text(json.dumps({"status":"failed","generatedAt":datetime.now(timezone.utc).isoformat(),"error":str(exc)[:500]},ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
        raise
