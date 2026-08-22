# -*- coding: utf-8 -*-
"""Aplica comandos operacionais no Firebase e confirma por releitura.

O arquivo de dispatch fica sem credenciais. A FIREBASE_KEY vem apenas de Secrets.
Operações suportadas:
- preventive_cycle_plan: posição do ciclo + programação mensal, opcionalmente ligada a ordens SAP;
- sap_order_upsert: cria/atualiza uma ordem SAP, registra histórico e, quando concluída,
  transforma as válvulas vinculadas em preventivas reais no histórico/painel.
"""
import json
import os
import re
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
def dv(v): return {"doubleValue": float(v)}
def bv(v): return {"booleanValue": bool(v)}
def av(values): return {"arrayValue": {"values": values}}

def ints(values): return av([iv(v) for v in values])
def strings(values): return av([sv(v) for v in values])


def decode_value(v):
    if "stringValue" in v: return v["stringValue"]
    if "integerValue" in v: return int(v["integerValue"])
    if "doubleValue" in v: return float(v["doubleValue"])
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


def safe_id(value):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", str(value).strip()).strip("-")


def normalize_sap_ids(values):
    out = []
    for value in values or []:
        text = str(value).strip()
        if text and text not in out:
            out.append(text)
    return out


def normalize_valves(values, line):
    out = []
    for value in values or []:
        n = int(value)
        if n < 1 or n > MAX_VALVES[line]:
            raise ValueError(f"válvula {n} inválida para L{line}")
        if n not in out:
            out.append(n)
    return out


def validate_preventive_plan(cfg):
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
    if not str(cfg.get("plannedDate", ""))[:10]:
        raise ValueError("plannedDate obrigatório")
    month = str(cfg.get("month", ""))
    if len(month) != 7 or month[4] != "-":
        raise ValueError("month deve ser YYYY-MM")
    if "linkedSapOrderIds" in cfg and not isinstance(cfg.get("linkedSapOrderIds"), list):
        raise ValueError("linkedSapOrderIds deve ser uma lista")
    return line, completed, planned, month


def apply_preventive_cycle_plan(cfg):
    line, completed, planned, month = validate_preventive_plan(cfg)
    request_id = str(cfg.get("requestId", ""))
    requested_at = str(cfg.get("requestedAt", ""))
    planned_date = str(cfg["plannedDate"])
    linked_sap_ids = normalize_sap_ids(cfg.get("linkedSapOrderIds", []))
    timestamp = now_iso()

    cycle_path = f"maintenance_cycle_state/{line}"
    cycle_r = get_doc(cycle_path)
    cycle_doc = cycle_r.json() if cycle_r.status_code == 200 else None
    if cycle_r.status_code not in (200, 404):
        cycle_r.raise_for_status()
    cycle_fields = {
        "line": sv(line),
        "lastCompletedValve": iv(completed),
        "completedThrough": iv(completed),
        "completedCount": preserve(cycle_doc, "completedCount", iv(completed)),
        "baselineCompletedCount": preserve(cycle_doc, "baselineCompletedCount", iv(completed)),
        "sapCompletedValves": preserve(cycle_doc, "sapCompletedValves", ints([])),
        "nextValve": iv(planned[0]),
        "cycleMax": iv(MAX_VALVES[line]),
        "source": sv("chatgpt_dispatch"),
        "baselineOnly": bv(True),
        "note": sv(f"Sequência preventiva confirmada até V{completed}; válvulas SAP concluídas passam a contar como preventivas."),
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
        "linkedSapOrderIds": strings(linked_sap_ids) if "linkedSapOrderIds" in cfg else preserve(existing_doc, "linkedSapOrderIds", strings([])),
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
    if "linkedSapOrderIds" in cfg:
        expected_plan = expected_plan and p.get("linkedSapOrderIds") == linked_sap_ids
    if not (expected_cycle and expected_plan):
        raise RuntimeError("releitura do Firebase não confirmou o estado solicitado")

    return {
        "status": "verified",
        "requestId": request_id,
        "requestedAt": requested_at,
        "operation": "preventive_cycle_plan",
        "line": line,
        "completedThrough": completed,
        "completedCount": c.get("completedCount", completed),
        "nextValve": planned[0],
        "plannedValves": planned,
        "plannedDate": planned_date,
        "month": month,
        "planId": plan_id,
        "linkedSapOrderIds": p.get("linkedSapOrderIds") or [],
        "verifiedAt": now_iso(),
        "message": "Ciclo preventivo, programação e vínculos SAP relidos e verificados no Firebase."
    }


def validate_sap_order(cfg):
    order = str(cfg.get("sapOrderNumber", "")).strip()
    line = str(cfg.get("line", "")).strip()
    month = str(cfg.get("month", "")).strip()
    if not order:
        raise ValueError("sapOrderNumber obrigatório")
    if line not in MAX_VALVES:
        raise ValueError("linha SAP inválida")
    if len(month) != 7 or month[4] != "-":
        raise ValueError("month deve ser YYYY-MM")
    status = str(cfg.get("status", "recebida")).strip().lower()
    if status not in {"recebida", "planejada", "em_andamento", "concluida", "cancelada"}:
        raise ValueError("status SAP inválido")
    if "linkedValves" in cfg and not isinstance(cfg.get("linkedValves"), list):
        raise ValueError("linkedValves deve ser uma lista")
    normalize_valves(cfg.get("linkedValves", []), line)
    return order, line, month, status


def write_valve_preventive_history(order, line, valves, event_date, description, closing_comment, source, timestamp):
    paths = []
    for valve in valves:
        history_id = safe_id(f"sap-{order}-v{valve}")
        path = f"lines/{line}/valves/{valve}/history/{history_id}"
        existing_r = get_doc(path)
        existing_doc = existing_r.json() if existing_r.status_code == 200 else None
        if existing_r.status_code not in (200, 404):
            existing_r.raise_for_status()
        text = description or f"Preventiva vinculada à ordem SAP {order}."
        fields = {
            "id": sv(history_id),
            "timestamp": sv(event_date),
            "type": sv("preventiva"),
            "subset": sv("SAP"),
            "description": sv(text),
            "executante": sv("SAP"),
            "turno": sv(""),
            "status": sv("ok"),
            "isCritical": bv(False),
            "source": sv(source),
            "sapOrderId": sv(order),
            "closingComment": sv(closing_comment),
            "line": sv(line),
            "valve": sv(valve),
            "createdAt": preserve(existing_doc, "createdAt", sv(timestamp)),
            "updatedAt": sv(timestamp),
        }
        r = patch_doc(path, fields)
        r.raise_for_status()
        check = get_doc(path); check.raise_for_status()
        h = decode_fields(check.json())
        if h.get("type") != "preventiva" or h.get("sapOrderId") != order or str(h.get("valve")) != str(valve):
            raise RuntimeError(f"releitura não confirmou preventiva SAP da V{valve}")
        paths.append(path)
    return paths


def update_plan_completion(line, month, valves, timestamp, request_id):
    plan_path = f"maintenance_plans/{month}-{line}"
    r = get_doc(plan_path)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    doc = r.json(); p = decode_fields(doc)
    planned = [int(v) for v in (p.get("valves") or [])]
    completed = [int(v) for v in (p.get("completedValves") or [])]
    for valve in valves:
        if valve in planned and valve not in completed:
            completed.append(valve)
    complete = bool(planned) and all(v in completed for v in planned)
    fields = {
        "month": preserve(doc, "month", sv(month)),
        "line": preserve(doc, "line", sv(line)),
        "targetCount": preserve(doc, "targetCount", iv(len(planned))),
        "startValve": preserve(doc, "startValve", iv(planned[0] if planned else 1)),
        "endValve": preserve(doc, "endValve", iv(planned[-1] if planned else 1)),
        "valves": preserve(doc, "valves", ints(planned)),
        "completedValves": ints(completed),
        "linkedSapOrderIds": preserve(doc, "linkedSapOrderIds", strings([])),
        "status": sv("concluido" if complete else ("em_andamento" if completed else str(p.get("status") or "planejado"))),
        "plannedDate": preserve(doc, "plannedDate", sv("")),
        "previousCompletedThrough": preserve(doc, "previousCompletedThrough", iv(0)),
        "source": preserve(doc, "source", sv("chatgpt_dispatch")),
        "createdAt": preserve(doc, "createdAt", sv(timestamp)),
        "updatedAt": sv(timestamp),
        "lastRequestId": sv(request_id),
    }
    patch_doc(plan_path, fields).raise_for_status()
    check = get_doc(plan_path); check.raise_for_status()
    out = decode_fields(check.json())
    if sorted(int(v) for v in (out.get("completedValves") or [])) != sorted(completed):
        raise RuntimeError("releitura não confirmou progresso do plano preventivo")
    return {"path": plan_path, "completedValves": completed, "status": out.get("status")}


def update_cycle_from_sap(line, valves, timestamp, request_id):
    path = f"maintenance_cycle_state/{line}"
    r = get_doc(path)
    doc = r.json() if r.status_code == 200 else None
    if r.status_code not in (200, 404):
        r.raise_for_status()
    c = decode_fields(doc) if doc else {}
    through = int(c.get("completedThrough") or c.get("lastCompletedValve") or 0)
    baseline = int(c.get("baselineCompletedCount") or c.get("completedCount") or through)
    recorded = normalize_valves(c.get("sapCompletedValves") or [], line)
    for valve in valves:
        if valve not in recorded:
            recorded.append(valve)

    contiguous = through
    recorded_set = set(recorded)
    while contiguous < MAX_VALVES[line] and (contiguous + 1) in recorded_set:
        contiguous += 1

    new_after_baseline = {v for v in recorded_set if v > baseline}
    completed_count = min(MAX_VALVES[line], baseline + len(new_after_baseline))
    completed_count = max(completed_count, contiguous)
    next_valve = 1 if contiguous >= MAX_VALVES[line] else contiguous + 1
    fields = {
        "line": sv(line),
        "lastCompletedValve": iv(contiguous),
        "completedThrough": iv(contiguous),
        "completedCount": iv(completed_count),
        "baselineCompletedCount": iv(baseline),
        "sapCompletedValves": ints(sorted(recorded_set)),
        "nextValve": iv(next_valve),
        "cycleMax": iv(MAX_VALVES[line]),
        "source": sv("sap_preventive_completion"),
        "baselineOnly": bv(False),
        "note": sv("Preventivas do painel contam válvulas concluídas vinculadas às ordens SAP."),
        "createdAt": preserve(doc, "createdAt", sv(timestamp)),
        "updatedAt": sv(timestamp),
        "lastRequestId": sv(request_id),
    }
    patch_doc(path, fields).raise_for_status()
    check = get_doc(path); check.raise_for_status()
    out = decode_fields(check.json())
    if int(out.get("completedCount") or 0) != completed_count or out.get("lastRequestId") != request_id:
        raise RuntimeError("releitura não confirmou contagem preventiva do ciclo")
    return {
        "completedThrough": int(out.get("completedThrough") or 0),
        "completedCount": int(out.get("completedCount") or 0),
        "nextValve": int(out.get("nextValve") or 1),
        "sapCompletedValves": out.get("sapCompletedValves") or [],
    }


def apply_sap_order_upsert(cfg):
    order, line, month, status = validate_sap_order(cfg)
    request_id = str(cfg.get("requestId", "")).strip()
    requested_at = str(cfg.get("requestedAt", ""))
    timestamp = now_iso()
    order_id = safe_id(order)
    if not order_id:
        raise ValueError("número SAP inválido")
    order_path = f"sap_orders/{order_id}"

    existing_r = get_doc(order_path)
    existing_doc = existing_r.json() if existing_r.status_code == 200 else None
    if existing_r.status_code not in (200, 404):
        existing_r.raise_for_status()

    description = str(cfg.get("description", "")).strip()
    system_status = str(cfg.get("systemStatus", "")).strip()
    start_date = str(cfg.get("startDate", "")).strip()
    actual_end = str(cfg.get("actualEndDate", "")).strip()
    maintenance_plan = str(cfg.get("maintenancePlan", "")).strip()
    sap_type = str(cfg.get("sapType", "")).strip()
    activity_type = str(cfg.get("activityType", "")).strip()
    source = str(cfg.get("source", "sap_iw38_chatgpt")).strip() or "sap_iw38_chatgpt"
    closing_comment = str(cfg.get("closingComment", "")).strip()
    linked_valves = normalize_valves(cfg.get("linkedValves", []), line)

    fields = {
        "sapOrderNumber": sv(order),
        "month": sv(month),
        "line": sv(line),
        "description": sv(description),
        "status": sv(status),
        "systemStatus": sv(system_status),
        "startDate": sv(start_date),
        "actualEndDate": sv(actual_end),
        "maintenancePlan": sv(maintenance_plan),
        "sapType": sv(sap_type),
        "activityType": sv(activity_type),
        "linkedValves": ints(linked_valves) if "linkedValves" in cfg else preserve(existing_doc, "linkedValves", ints([])),
        "closingComment": sv(closing_comment) if "closingComment" in cfg else preserve(existing_doc, "closingComment", sv("")),
        "totalValue": preserve(existing_doc, "totalValue", dv(0)),
        "materials": preserve(existing_doc, "materials", av([])),
        "source": sv(source),
        "createdAt": preserve(existing_doc, "createdAt", sv(timestamp)),
        "updatedAt": sv(timestamp),
        "lastRequestId": sv(request_id),
    }
    r = patch_doc(order_path, fields)
    r.raise_for_status()

    event_type = str(cfg.get("historyEvent", status)).strip() or status
    event_date = actual_end or start_date or requested_at or timestamp
    event_id = safe_id(request_id or f"{event_type}-{event_date}")[:120]
    history_path = f"{order_path}/history/{event_id}"
    history_fields = {
        "event": sv(event_type),
        "status": sv(status),
        "eventDate": sv(event_date),
        "description": sv(str(cfg.get("historyDescription", "")).strip() or f"Ordem SAP {order} atualizada para {status}."),
        "closingComment": sv(closing_comment),
        "linkedValves": ints(linked_valves),
        "systemStatus": sv(system_status),
        "source": sv(source),
        "requestId": sv(request_id),
        "createdAt": sv(timestamp),
    }
    r = patch_doc(history_path, history_fields)
    r.raise_for_status()

    preventive_paths = []
    plan_result = None
    cycle_result = None
    if status == "concluida" and linked_valves:
        preventive_paths = write_valve_preventive_history(
            order, line, linked_valves, event_date, description, closing_comment, source, timestamp
        )
        plan_result = update_plan_completion(line, month, linked_valves, timestamp, request_id)
        cycle_result = update_cycle_from_sap(line, linked_valves, timestamp, request_id)

    order_check = get_doc(order_path)
    hist_check = get_doc(history_path)
    order_check.raise_for_status(); hist_check.raise_for_status()
    o = decode_fields(order_check.json())
    h = decode_fields(hist_check.json())
    if not (o.get("sapOrderNumber") == order and o.get("line") == line and o.get("status") == status and o.get("lastRequestId") == request_id):
        raise RuntimeError("releitura não confirmou a ordem SAP")
    if "linkedValves" in cfg and [int(v) for v in (o.get("linkedValves") or [])] != linked_valves:
        raise RuntimeError("releitura não confirmou as válvulas da ordem SAP")
    if not (h.get("event") == event_type and h.get("requestId") == request_id):
        raise RuntimeError("releitura não confirmou o histórico da ordem SAP")

    return {
        "status": "verified",
        "requestId": request_id,
        "requestedAt": requested_at,
        "operation": "sap_order_upsert",
        "sapOrderNumber": order,
        "line": line,
        "month": month,
        "sapStatus": status,
        "systemStatus": system_status,
        "actualEndDate": actual_end,
        "linkedValves": linked_valves,
        "closingComment": closing_comment,
        "historyEvent": event_type,
        "historyPath": history_path,
        "preventiveHistoryPaths": preventive_paths,
        "planProgress": plan_result,
        "cycle": cycle_result,
        "verifiedAt": now_iso(),
        "message": "Ordem SAP, histórico e preventivas vinculadas foram relidos e verificados no Firebase."
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
        operation = cfg.get("operation")
        if operation == "preventive_cycle_plan":
            result = apply_preventive_cycle_plan(cfg)
        elif operation == "sap_order_upsert":
            result = apply_sap_order_upsert(cfg)
        else:
            raise ValueError("operation não suportada")
        write_status(status_path, result)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as exc:
        base.update({"status": "failed", "error": str(exc), "verifiedAt": now_iso()})
        write_status(status_path, base)
        raise


if __name__ == "__main__":
    main()
