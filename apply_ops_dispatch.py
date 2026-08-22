# -*- coding: utf-8 -*-
"""Aplica comandos operacionais mínimos no Firebase e confirma por releitura.

O arquivo de dispatch fica sem credenciais. A FIREBASE_KEY vem apenas de Secrets.
Neste primeiro contrato suportamos preventive_cycle_plan, mantendo o histórico
mensal limpo: o avanço anterior do ciclo fica em maintenance_cycle_state e não
é inventado como 41 intervenções individuais sem datas/detalhes.
"""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

FIREBASE_KEY = os.environ["FIREBASE_KEY"]
PROJECT = os.environ.get("FIREBASE_PROJ", "sala-valvulas-ow-163b3")
ROOT = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents"
MAX_VALVES = {"512": 175, "513": 175, "514": 72}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def url(path):
    return f"{ROOT}/{path}?key={FIREBASE_KEY}"


def get_doc(path):
    return requests.get(url(path), timeout=30)


def patch_doc(path, fields):
    return requests.patch(url(path), json={"fields": fields}, timeout=30)


def sv(v): return {"stringValue": str(v)}
def iv(v): return {"integerValue": str(int(v))}
def bv(v): return {"booleanValue": bool(v)}
def av(values): return {"arrayValue": {"values": values}}

def ints(values): return av([iv(v) for v in values])
def strings(values): return av([sv(v) for v in values])


def decode_value(v):
    if "stringValue" in v: return v["stringValue"]
    if "integerValue" in v: return int(v["integerValue"])
    if "booleanValue" in v: return bool(v["booleanValue"])
    if "arrayValue" in v: return [decode_value(x) for x in v.get("arrayValue", {}).get("values", [])]
    return None


def decode_fields(doc):
    return {k: decode_value(v) for k, v in doc.get("fields", {}).items()}


def preserve(existing, name, fallback):
    if existing and name in existing.get("fields", {}):
        return existing["fields"][name]
    return fallback


def write_status(path, payload):
    Path(path).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def validate_dispatch(cfg):
    if not cfg.get("enabled", False):
        return None
    if cfg.get("operation") != "preventive_cycle_plan":
        raise ValueError("operation não suportada")
    line = str(cfg.get("line", ""))
    if line not in MAX_VALVES:
        raise ValueError("linha inválida")
    completed = int(cfg.get("completedThrough", 0))
    planned = [int(v) for v in cfg.get("plannedValves", [])]
    if not (1 <= completed <= MAX_VALVES[line]):
        raise ValueError("completedThrough inválido")
    if not planned:
        raise ValueError("plannedValves vazio")
    if any(v < 1 or v > MAX_VALVES[line] for v in planned):
        raise ValueError("plannedValves contém válvula inválida")
    expected = list(range(completed + 1, completed + 1 + len(planned)))
    if expected[-1] <= MAX_VALVES[line] and planned != expected:
        raise ValueError("plannedValves deve continuar sequencialmente após completedThrough")
    if str(cfg.get("plannedDate", ""))[:10] == "":
        raise ValueError("plannedDate obrigatório")
    month = str(cfg.get("month", ""))
    if len(month) != 7 or month[4] != "-":
        raise ValueError("month deve ser YYYY-MM")
    return line, completed, planned, month


def apply_preventive_cycle_plan(cfg):
    line, completed, planned, month = validate_dispatch(cfg)
    request_id = str(cfg.get("requestId", ""))
    requested_at = str(cfg.get("requestedAt", ""))
    planned_date = str(cfg["plannedDate"])
    timestamp = now_iso()

    cycle_path = f"maintenance_cycle_state/{line}"
    cycle_fields = {
        "line": sv(line),
        "lastCompletedValve": iv(completed),
        "completedThrough": iv(completed),
        "nextValve": iv(planned[0]),
        "cycleMax": iv(MAX_VALVES[line]),
        "source": sv("chatgpt_dispatch"),
        "baselineOnly": bv(True),
        "note": sv(f"Sequência preventiva confirmada até V{completed}; não cria intervenções históricas sem data/detalhes."),
        "updatedAt": sv(timestamp),
        "lastRequestId": sv(request_id),
    }
    r = patch_doc(cycle_path, cycle_fields)
    r.raise_for_status()

    plan_id = f"{month}-{line}"
    plan_path = f"maintenance_plans/{plan_id}"
    existing_r = get_doc(plan_path)
    existing_doc = existing_r.json() if existing_r.status_code == 200 else None
    if existing_r.status_code not in (200, 404):
        existing_r.raise_for_status()
    existing_decoded = decode_fields(existing_doc) if existing_doc else {}
    old_valves = [int(v) for v in (existing_decoded.get("valves") or [])]
    if old_valves and old_valves != planned:
        raise RuntimeError(f"Já existe programação conflitante em {plan_id}: {old_valves}")

    plan_fields = {
        "month": sv(month),
        "line": sv(line),
        "targetCount": iv(len(planned)),
        "startValve": iv(planned[0]),
        "endValve": iv(planned[-1]),
        "valves": ints(planned),
        "completedValves": preserve(existing_doc, "completedValves", ints([])),
        "linkedSapOrderIds": preserve(existing_doc, "linkedSapOrderIds", strings([])),
        "status": preserve(existing_doc, "status", sv("planejado")),
        "plannedDate": sv(planned_date),
        "previousCompletedThrough": iv(completed),
        "source": sv("chatgpt_dispatch"),
        "createdAt": preserve(existing_doc, "createdAt", sv(timestamp)),
        "updatedAt": sv(timestamp),
        "lastRequestId": sv(request_id),
    }
    r = patch_doc(plan_path, plan_fields)
    r.raise_for_status()

    cycle_check = get_doc(cycle_path)
    plan_check = get_doc(plan_path)
    cycle_check.raise_for_status(); plan_check.raise_for_status()
    c = decode_fields(cycle_check.json())
    p = decode_fields(plan_check.json())

    expected_cycle = c.get("lastCompletedValve") == completed and c.get("nextValve") == planned[0] and c.get("lastRequestId") == request_id
    expected_plan = p.get("valves") == planned and p.get("plannedDate") == planned_date and p.get("lastRequestId") == request_id
    if not (expected_cycle and expected_plan):
        raise RuntimeError("releitura do Firebase não confirmou o estado solicitado")

    return {
        "status": "verified",
        "requestId": request_id,
        "requestedAt": requested_at,
        "operation": "preventive_cycle_plan",
        "line": line,
        "completedThrough": completed,
        "nextValve": planned[0],
        "plannedValves": planned,
        "plannedDate": planned_date,
        "month": month,
        "planId": plan_id,
        "verifiedAt": now_iso(),
        "message": "Ciclo preventivo e programação relidos e verificados no Firebase."
    }


def main():
    dispatch_path = sys.argv[1] if len(sys.argv) > 1 else "ops_dispatch.json"
    status_path = sys.argv[2] if len(sys.argv) > 2 else "ops_dispatch_status.json"
    cfg = json.loads(Path(dispatch_path).read_text(encoding="utf-8"))
    if not cfg.get("enabled", False):
        print("Dispatch operacional desativado.")
        return
    base = {
        "status": "running",
        "requestId": str(cfg.get("requestId", "")),
        "requestedAt": str(cfg.get("requestedAt", "")),
        "operation": str(cfg.get("operation", "")),
        "generatedAt": now_iso(),
    }
    write_status(status_path, base)
    try:
        result = apply_preventive_cycle_plan(cfg)
        write_status(status_path, result)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as exc:
        base.update({"status": "failed", "error": str(exc), "verifiedAt": now_iso()})
        write_status(status_path, base)
        raise


if __name__ == "__main__":
    main()
