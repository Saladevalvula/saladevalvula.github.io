# -*- coding: utf-8 -*-
import requests, time, sys, os
from datetime import datetime, timezone

NOTION_TOKEN  = os.environ["NOTION_TOKEN"]
NOTION_DB_ID  = os.environ.get("NOTION_DB_ID", "82e7f043-0a3f-4609-8853-a32d96f7a7d2")
FIREBASE_KEY  = os.environ["FIREBASE_KEY"]
FIREBASE_PROJ = os.environ.get("FIREBASE_PROJ", "sala-valvulas-ow-163b3")
FIREBASE_URL  = f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJ}/databases/(default)/documents:commit?key={FIREBASE_KEY}"
DOC_BASE      = f"projects/{FIREBASE_PROJ}/databases/(default)/documents"

PROP_VALVULA     = "V\u00e1lvula"
PROP_INTERVENCAO = "Interven\u00e7\u00e3o"
PROP_OBSERVACAO  = "Observa\u00e7\u00e3o"

def hdr():
    return {"Authorization": f"Bearer {NOTION_TOKEN}", "Notion-Version": "2022-06-28", "Content-Type": "application/json"}

def txt(p):
    if not p: return ""
    t = p.get("type", "")
    return "".join(x["plain_text"] for x in p.get(t, []))

def sel(p): return ((p or {}).get("select") or {}).get("name", "")
def msel(p): return [s["name"] for s in (p or {}).get("multi_select", [])]
def dat(p): return ((p or {}).get("date") or {}).get("start")

def build_body(lid, vid, rec):
    doc = f"{DOC_BASE}/lines/{lid}/valves/{vid}"
    fields = {
        "id":          {"stringValue": rec["id"]},
        "timestamp":   {"stringValue": rec["timestamp"]},
        "subset":      {"stringValue": rec["subset"]},
        "type":        {"stringValue": rec["type"]},
        "description": {"stringValue": rec["description"]},
        "executante":  {"stringValue": ""},
        "turno":       {"stringValue": ""},
        "status":      {"stringValue": rec["status"]},
        "isCritical":  {"booleanValue": False},
        "photos":      {"arrayValue": {"values": []}}
    }
    return {"writes": [
        {"update": {"name": doc, "fields": {"valveNumber": {"integerValue": int(vid)}}}, "updateMask": {"fieldPaths": ["valveNumber"]}},
        {"transform": {"document": doc, "fieldTransforms": [{"fieldPath": "historico", "appendMissingElements": {"values": [{"mapValue": {"fields": fields}}]}}]}}
    ]}

def sync(n=10):
    print(f"Buscando {n} registros do Notion...")
    r = requests.post(f"https://api.notion.com/v1/databases/{NOTION_DB_ID}/query", headers=hdr(),
        json={"page_size": n, "sorts": [{"property": "Data", "direction": "descending"}]})
    r.raise_for_status()
    pages = r.json().get("results", [])
    print(f"{len(pages)} encontrados")
    ok = err = skip = 0
    for page in pages:
        p = page.get("properties", {})
        linha = sel(p.get("Linha"))
        valv  = txt(p.get(PROP_VALVULA))
        if not linha or not valv:
            skip += 1
            continue
        lid = linha.replace("L","").strip()
        vid = "".join(filter(str.isdigit, valv)) or "0"
        tipo = "corretiva" if "corretiva" in sel(p.get("Tipo","")).lower() else "preventiva"
        st   = "pendente" if "Jumper" in sel(p.get("Status","")) or "Pend" in sel(p.get("Status","")) else "ok"
        d    = dat(p.get("Data"))
        ts   = datetime.fromisoformat(d).replace(tzinfo=timezone.utc).isoformat() if d else datetime.now(timezone.utc).isoformat()
        iv = txt(p.get(PROP_INTERVENCAO))
        ca = txt(p.get("Causa"))
        ob = txt(p.get(PROP_OBSERVACAO))
        parts = ([f"[{iv}]"] if iv else []) + ([ca] if ca else []) + ([ob] if ob else [])
        desc = " | ".join(parts) or "Manutencao"
        for i, sub in enumerate(msel(p.get("Componente")) or ["Geral"]):
            rec = {"id": str(int(time.time()*1000)+i), "timestamp": ts, "subset": sub,
                   "type": tipo, "description": desc, "status": st}
            resp = requests.post(FIREBASE_URL, json=build_body(lid, vid, rec))
            if resp.status_code in (200,201): print(f"  OK  L{lid} V{vid} [{sub}]"); ok += 1
            else: print(f"  ERR L{lid} V{vid} -> {resp.status_code}"); err += 1
    print(f"OK:{ok} Err:{err} Skip:{skip}")

sync(int(sys.argv[1]) if len(sys.argv)>1 else 10)
