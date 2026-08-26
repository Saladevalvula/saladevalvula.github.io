# -*- coding: utf-8 -*-
"""Registra uma única página do Notion no histórico V2 do Firestore.

Histórico V2:
  lines/{linha}/valves/{valvula}/history/{recordId}

A página do Notion continua sendo a identidade lógica. O sync_index guarda
linha, válvula e recordIds para permitir edição de componente ou mudança de
válvula sem deixar cópias antigas.
"""
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import requests

NOTION_TOKEN = os.environ["NOTION_TOKEN"]
FIREBASE_KEY = os.environ["FIREBASE_KEY"]
FIREBASE_PROJ = os.environ.get("FIREBASE_PROJ", "sala-valvulas-ow-163b3")
ROOT = f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJ}/databases/(default)/documents"
LOCAL_TZ = ZoneInfo("America/Sao_Paulo")

MAX_VALVES = {"512": 175, "513": 175, "514": 72}
TYPE_MAP = {"corretiva": "corretiva", "preventiva": "preventiva", "diagnóstico": "inspecao", "diagnostico": "inspecao"}


def notion_headers():
    return {"Authorization": f"Bearer {NOTION_TOKEN}", "Notion-Version": "2022-06-28", "Content-Type": "application/json"}


def txt(prop):
    if not prop:
        return ""
    t = prop.get("type", "")
    return "".join(x.get("plain_text", "") for x in prop.get(t, []))


def sel(prop):
    return ((prop or {}).get("select") or {}).get("name", "")


def msel(prop):
    return [x["name"] for x in (prop or {}).get("multi_select", [])]


def dat(prop):
    return ((prop or {}).get("date") or {}).get("start")


def normalize_timestamp(value):
    if not value:
        return datetime.now(timezone.utc).isoformat()
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        # Datas do Notion sem fuso (inclusive YYYY-MM-DD) representam a data
        # local da manutenção. Assumir UTC aqui fazia 00:00 virar 21:00 do dia
        # anterior no app. Interpretamos como America/Sao_Paulo antes de UTC.
        dt = dt.replace(tzinfo=LOCAL_TZ)
    return dt.astimezone(timezone.utc).isoformat()


def normalize_subset(component):
    v = (component or "Geral").strip()
    return "SONDA" if v.casefold() in {"sonda", "jumper"} else v


def stable_record_id(page_id, subset):
    return "notion-" + hashlib.sha1(f"{page_id}:{subset}".encode()).hexdigest()[:20]


def s(v): return {"stringValue": str(v)}
def b(v): return {"booleanValue": bool(v)}
def arr_s(values): return {"arrayValue": {"values": [s(v) for v in values]}}


def doc_url(path):
    return f"{ROOT}/{path}?key={FIREBASE_KEY}"


def get_doc(path):
    return requests.get(doc_url(path), timeout=30)


def patch_doc(path, fields, update_mask=None):
    url = doc_url(path)
    if update_mask:
        # Rebuild URL because the key is already present.
        masks = "&".join(f"updateMask.fieldPaths={m}" for m in update_mask)
        url += "&" + masks
    return requests.patch(url, json={"fields": fields}, timeout=30)


def delete_doc(path):
    return requests.delete(doc_url(path), timeout=30)


def list_history(line, valve):
    url = f"{ROOT}/lines/{line}/valves/{valve}/history?pageSize=500&key={FIREBASE_KEY}"
    r = requests.get(url, timeout=30)
    if r.status_code == 404:
        return []
    r.raise_for_status()
    return r.json().get("documents", [])


def field_string(doc_or_fields, name):
    fields = doc_or_fields.get("fields", doc_or_fields)
    return fields.get(name, {}).get("stringValue", "")


def read_index(page_id):
    r = get_doc(f"sync_index/{page_id}")
    if r.status_code == 404:
        return None
    r.raise_for_status()
    f = r.json().get("fields", {})
    ids = [v.get("stringValue", "") for v in f.get("recordIds", {}).get("arrayValue", {}).get("values", [])]
    return {"line": field_string(f, "line"), "valve": field_string(f, "valve"), "recordIds": [x for x in ids if x]}


def write_index(page_id, line, valve, record_ids):
    fields = {"line": s(line), "valve": s(valve), "recordIds": arr_s(record_ids), "updatedAt": s(datetime.now(timezone.utc).isoformat()), "schemaVersion": s("history_v2")}
    r = patch_doc(f"sync_index/{page_id}", fields)
    if r.status_code not in (200, 201):
        raise RuntimeError(f"Falha no sync_index: {r.status_code} {r.text[:300]}")


def fetch_notion_page(page_id):
    r = requests.get(f"https://api.notion.com/v1/pages/{page_id}", headers=notion_headers(), timeout=30)
    r.raise_for_status()
    return r.json()


def build_records(page):
    props = page.get("properties", {})
    page_id = page.get("id", "")
    line_raw = sel(props.get("Linha")).strip()
    valve_raw = txt(props.get("Válvula")).strip()
    type_raw = sel(props.get("Tipo")).strip()
    if not line_raw or not valve_raw:
        raise ValueError("Linha ou Válvula vazia")
    line = line_raw[1:] if line_raw.upper().startswith("L") else line_raw
    if line not in MAX_VALVES:
        raise ValueError(f"Linha não suportada: {line_raw}")
    if not re.fullmatch(r"\d+", valve_raw):
        raise ValueError(f"Válvula deve conter apenas número: {valve_raw}")
    valve = str(int(valve_raw))
    if not 1 <= int(valve) <= MAX_VALVES[line]:
        raise ValueError(f"Válvula fora da faixa da L{line}: {valve} (máx. {MAX_VALVES[line]})")
    app_type = TYPE_MAP.get(type_raw.casefold())
    if not app_type:
        raise ValueError(f"Tipo não mapeado: {type_raw}")
    status_raw = sel(props.get("Status"))
    status = "pendente" if ("jumper" in status_raw.casefold() or "pend" in status_raw.casefold()) else "ok"
    timestamp = normalize_timestamp(dat(props.get("Data")) or page.get("last_edited_time") or page.get("created_time"))
    intervention, cause, observation = txt(props.get("Intervenção")), txt(props.get("Causa")), txt(props.get("Observação"))
    parts = ([f"[{intervention}]"] if intervention else []) + ([cause] if cause else []) + ([observation] if observation else [])
    description = " | ".join(parts) or "Manutenção"
    subsets = []
    for comp in msel(props.get("Componente")) or ["Geral"]:
        sub = normalize_subset(comp)
        if sub and sub not in subsets:
            subsets.append(sub)
    now = datetime.now(timezone.utc).isoformat()
    records = []
    for subset in subsets:
        rid = stable_record_id(page_id, subset)
        records.append({"id": rid, "notionPageId": page_id, "timestamp": timestamp, "subset": subset, "type": app_type, "description": description, "executante": "", "turno": "", "status": status, "isCritical": False, "source": "chatgpt_notion_dispatch", "line": line, "valve": valve, "updatedAt": now})
    return line, valve, records


def record_fields(record, existing_created_at=None):
    return {
        "id": s(record["id"]), "notionPageId": s(record["notionPageId"]), "source": s(record["source"]),
        "timestamp": s(record["timestamp"]), "subset": s(record["subset"]), "type": s(record["type"]),
        "description": s(record["description"]), "executante": s(record.get("executante", "")), "turno": s(record.get("turno", "")),
        "status": s(record["status"]), "isCritical": b(record.get("isCritical", False)), "line": s(record["line"]), "valve": s(record["valve"]),
        "createdAt": s(existing_created_at or record.get("updatedAt") or datetime.now(timezone.utc).isoformat()), "updatedAt": s(record.get("updatedAt") or datetime.now(timezone.utc).isoformat())
    }


def matching_page_record_ids(line, valve, page_id):
    out = []
    for doc in list_history(line, valve):
        if field_string(doc, "notionPageId") == page_id:
            out.append(doc["name"].split("/")[-1])
    return out


def upsert_records(line, valve, page_id, records, previous):
    # Parent doc only keeps metadata/status; history is now a subcollection.
    parent = patch_doc(f"lines/{line}/valves/{valve}", {"valveNumber": {"integerValue": int(valve)}}, ["valveNumber"])
    if parent.status_code not in (200, 201):
        raise RuntimeError(f"Falha ao preparar válvula: {parent.status_code} {parent.text[:300]}")

    new_ids = [r["id"] for r in records]
    old_line = previous.get("line") if previous else line
    old_valve = previous.get("valve") if previous else valve
    old_ids = list(previous.get("recordIds", [])) if previous else []
    if previous and not old_ids and old_line and old_valve:
        old_ids = matching_page_record_ids(old_line, old_valve, page_id)
    if not previous:
        old_ids = matching_page_record_ids(line, valve, page_id)

    # Remove stale docs if line/valve/subsets changed.
    for rid in old_ids:
        if old_line != line or old_valve != valve or rid not in new_ids:
            dr = delete_doc(f"lines/{old_line}/valves/{old_valve}/history/{rid}")
            if dr.status_code not in (200, 404):
                raise RuntimeError(f"Falha ao remover registro antigo {rid}: {dr.status_code} {dr.text[:200]}")

    for rec in records:
        path = f"lines/{line}/valves/{valve}/history/{rec['id']}"
        existing = get_doc(path)
        created_at = None
        if existing.status_code == 200:
            created_at = field_string(existing.json(), "createdAt") or None
        elif existing.status_code != 404:
            raise RuntimeError(f"Falha ao ler registro atual: {existing.status_code} {existing.text[:200]}")
        wr = patch_doc(path, record_fields(rec, created_at))
        if wr.status_code not in (200, 201):
            raise RuntimeError(f"Firebase retornou {wr.status_code}: {wr.text[:500]}")

    write_index(page_id, line, valve, new_ids)
    return new_ids


def verify(line, valve, page_id, records):
    docs = list_history(line, valve)
    page_docs = [d for d in docs if field_string(d, "notionPageId") == page_id]
    if len(page_docs) != len(records):
        raise RuntimeError(f"Verificação falhou: esperado {len(records)} registro(s), encontrado {len(page_docs)}")
    verified = []
    by_id = {d["name"].split("/")[-1]: d for d in page_docs}
    for r in records:
        d = by_id.get(r["id"])
        if not d:
            raise RuntimeError(f"Verificação falhou: documento {r['id']} ausente")
        checks = {"id": r["id"], "notionPageId": page_id, "subset": r["subset"], "type": r["type"], "description": r["description"], "status": r["status"], "line": line, "valve": valve}
        for k, expected in checks.items():
            actual = field_string(d, k)
            if actual != expected:
                raise RuntimeError(f"Verificação falhou em {r['subset']}/{k}: esperado {expected!r}, encontrado {actual!r}")
        verified.append({"subset": r["subset"], "type": r["type"], "count": 1})
    idx = read_index(page_id)
    if not idx or idx["line"] != line or idx["valve"] != valve or set(idx.get("recordIds", [])) != {r["id"] for r in records}:
        raise RuntimeError("Verificação falhou: sync_index inconsistente")
    return verified


def register_page(page_id):
    page = fetch_notion_page(page_id)
    canonical = page.get("id", page_id)
    line, valve, records = build_records(page)
    previous = read_index(canonical)
    upsert_records(line, valve, canonical, records, previous)
    verified = verify(line, valve, canonical, records)
    print(f"VERIFICADO V2 L{line} V{valve} [{', '.join(r['subset'] for r in records)}] page={canonical}")
    return {"pageId": canonical, "line": line, "valve": valve, "records": verified}


def write_result(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2); f.write("\n")


def main():
    dispatch_path = sys.argv[1] if len(sys.argv) > 1 else "maintenance_dispatch.json"
    result_path = sys.argv[2] if len(sys.argv) > 2 else "maintenance_dispatch_status.json"
    with open(dispatch_path, encoding="utf-8") as f:
        dispatch = json.load(f)
    if not dispatch.get("enabled", False):
        print("Dispatch desativado: nada a registrar e status anterior preservado.")
        return
    page_id = str(dispatch.get("pageId", "")).strip(); requested = str(dispatch.get("requestedAt", "")).strip()
    if not page_id:
        raise SystemExit("pageId ausente no dispatch")
    try:
        summary = register_page(page_id)
        write_result(result_path, {"status":"verified","schema":"history_v2","pageId":summary["pageId"],"requestedAt":requested,"verifiedAt":datetime.now(timezone.utc).isoformat(),"line":summary["line"],"valve":summary["valve"],"records":summary["records"],"message":"Firebase V2 confirmado após leitura: exatamente um documento por subset."})
    except Exception as exc:
        write_result(result_path, {"status":"failed","schema":"history_v2","pageId":page_id,"requestedAt":requested,"verifiedAt":datetime.now(timezone.utc).isoformat(),"error":str(exc)})
        raise


if __name__ == "__main__":
    main()
