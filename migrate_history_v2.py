# -*- coding: utf-8 -*-
"""Migração idempotente do histórico legado em arrays para subcoleções history.

Nunca apaga o array legado. Primeiro pode rodar em dry-run; em apply grava os
novos documentos, espelha oportunidades em work_orders e só então marca
system/history_v2.completed=true após verificação.
"""
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

FIREBASE_KEY = os.environ["FIREBASE_KEY"]
PROJECT = os.environ.get("FIREBASE_PROJ", "sala-valvulas-ow-163b3")
ROOT = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents"
LINES = ["512", "513", "514"]


def s(v): return {"stringValue": str(v)}
def b(v): return {"booleanValue": bool(v)}

def url(path): return f"{ROOT}/{path}?key={FIREBASE_KEY}"

def list_collection(path, page_size=500):
    out, token = [], None
    while True:
        u = f"{ROOT}/{path}?pageSize={page_size}&key={FIREBASE_KEY}"
        if token: u += f"&pageToken={token}"
        r = requests.get(u, timeout=30)
        if r.status_code == 404: return []
        r.raise_for_status()
        body = r.json(); out.extend(body.get("documents", [])); token = body.get("nextPageToken")
        if not token: return out

def get_doc(path): return requests.get(url(path), timeout=30)

def patch_doc(path, fields): return requests.patch(url(path), json={"fields": fields}, timeout=30)

def field_string(fields, name): return fields.get(name, {}).get("stringValue", "")

def map_fields(value): return value.get("mapValue", {}).get("fields", {})

def safe_id(value):
    return bool(value) and "/" not in value and value not in {".", ".."} and len(value.encode()) < 1400


def migrated_doc_id(line, valve, fields):
    original = field_string(fields, "id")
    notion = field_string(fields, "notionPageId")
    if notion and safe_id(original):
        return original
    fingerprint = {
        "line": line, "valve": valve,
        "id": original,
        "timestamp": field_string(fields, "timestamp"),
        "subset": field_string(fields, "subset"),
        "type": field_string(fields, "type"),
        "description": field_string(fields, "description"),
    }
    raw = json.dumps(fingerprint, ensure_ascii=False, sort_keys=True).encode()
    return "legacy-" + hashlib.sha1(raw).hexdigest()[:24]


def enriched_fields(line, valve, fields):
    now = datetime.now(timezone.utc).isoformat()
    out = dict(fields)
    out.pop("photos", None)
    out["line"] = s(line)
    out["valve"] = s(valve)
    if "source" not in out: out["source"] = s("legacy_migration")
    if "createdAt" not in out: out["createdAt"] = s(field_string(fields, "timestamp") or now)
    out["updatedAt"] = s(field_string(fields, "updatedAt") or now)
    if "isCritical" not in out: out["isCritical"] = b(False)
    return out


def collect_history_plan():
    planned = {}
    legacy_count = 0
    per_line = {}
    for line in LINES:
        valves = list_collection(f"lines/{line}/valves", 300)
        line_count = 0
        for doc in valves:
            valve = doc["name"].split("/")[-1]
            values = doc.get("fields", {}).get("historico", {}).get("arrayValue", {}).get("values", [])
            for item in values:
                fields = map_fields(item)
                if not fields: continue
                legacy_count += 1; line_count += 1
                rid = migrated_doc_id(line, valve, fields)
                path = f"lines/{line}/valves/{valve}/history/{rid}"
                planned[path] = enriched_fields(line, valve, fields)
        per_line[line] = line_count
    return planned, legacy_count, per_line


def collect_opportunity_plan():
    planned = {}
    for doc in list_collection("oportunidades", 500):
        doc_id = doc["name"].split("/")[-1]
        f = dict(doc.get("fields", {}))
        created = field_string(f, "createdAt") or datetime.now(timezone.utc).isoformat()
        if "status" not in f: f["status"] = s("aberta")
        if "priority" not in f: f["priority"] = s("Normal")
        if "osNumber" not in f: f["osNumber"] = s(f"OS-LEG-{doc_id[:6].upper()}")
        f["createdAt"] = s(created)
        f["updatedAt"] = s(datetime.now(timezone.utc).isoformat())
        f["source"] = s("legacy_opportunity")
        planned[f"work_orders/{doc_id}"] = f
    return planned


def existing_count(planned):
    count = 0
    for path in planned:
        r = get_doc(path)
        if r.status_code == 200: count += 1
        elif r.status_code != 404: r.raise_for_status()
    return count


def apply_plan(planned):
    failures = []
    for i, (path, fields) in enumerate(planned.items(), 1):
        r = patch_doc(path, fields)
        if r.status_code not in (200, 201): failures.append((path, r.status_code, r.text[:200]))
        if i % 50 == 0: print(f"Gravados {i}/{len(planned)}")
    if failures:
        raise RuntimeError(f"Falhas de gravação: {failures[:5]} (total={len(failures)})")


def verify_plan(planned):
    missing = []
    for path in planned:
        r = get_doc(path)
        if r.status_code != 200: missing.append((path, r.status_code))
    if missing:
        raise RuntimeError(f"Verificação encontrou documentos ausentes: {missing[:5]} (total={len(missing)})")


def write_marker(history_docs, legacy_count, per_line, work_orders):
    now = datetime.now(timezone.utc).isoformat()
    fields = {
        "completed": b(True), "schemaVersion": s("history_v2"), "completedAt": s(now),
        "historyDocuments": {"integerValue": history_docs}, "legacyHistoryItems": {"integerValue": legacy_count},
        "workOrdersMirrored": {"integerValue": work_orders},
        "line512": {"integerValue": per_line.get("512", 0)}, "line513": {"integerValue": per_line.get("513", 0)}, "line514": {"integerValue": per_line.get("514", 0)},
    }
    r = patch_doc("system/history_v2", fields)
    if r.status_code not in (200, 201): raise RuntimeError(f"Falha ao gravar marker: {r.status_code} {r.text[:300]}")


def main():
    config_path = Path(sys.argv[1] if len(sys.argv) > 1 else "history_v2_migration.json")
    status_path = Path(sys.argv[2] if len(sys.argv) > 2 else "history_v2_migration_status.json")
    cfg = json.loads(config_path.read_text(encoding="utf-8"))
    if not cfg.get("enabled", False):
        print("Migração desativada."); return
    apply = bool(cfg.get("apply", False))
    requested = str(cfg.get("requestedAt", ""))
    history, legacy_count, per_line = collect_history_plan()
    work = collect_opportunity_plan()
    already = existing_count(history)
    result = {
        "status": "dry_run" if not apply else "running", "requestedAt": requested,
        "legacyHistoryItems": legacy_count, "uniqueHistoryDocuments": len(history), "alreadyExistingHistoryDocuments": already,
        "wouldCreateOrUpdate": len(history), "workOrdersToMirror": len(work), "perLine": per_line,
        "generatedAt": datetime.now(timezone.utc).isoformat()
    }
    status_path.write_text(json.dumps(result, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not apply: return
    try:
        apply_plan(history); apply_plan(work); verify_plan(history); verify_plan(work)
        write_marker(len(history), legacy_count, per_line, len(work))
        result.update({"status":"verified","verifiedAt":datetime.now(timezone.utc).isoformat(),"message":"Histórico V2 migrado e verificado sem apagar o array legado."})
        status_path.write_text(json.dumps(result, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
        print(result["message"])
    except Exception as exc:
        result.update({"status":"failed","error":str(exc),"verifiedAt":datetime.now(timezone.utc).isoformat()})
        status_path.write_text(json.dumps(result, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
        raise


if __name__ == '__main__':
    main()
