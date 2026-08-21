# -*- coding: utf-8 -*-
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

import requests

NOTION_TOKEN = os.environ["NOTION_TOKEN"]
FIREBASE_KEY = os.environ["FIREBASE_KEY"]
FIREBASE_PROJ = os.environ.get("FIREBASE_PROJ", "sala-valvulas-ow-163b3")

FIREBASE_ROOT = (
    f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJ}"
    f"/databases/(default)/documents"
)
FIREBASE_COMMIT_URL = (
    f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJ}"
    f"/databases/(default)/documents:commit?key={FIREBASE_KEY}"
)
DOC_BASE = f"projects/{FIREBASE_PROJ}/databases/(default)/documents"

PROP_VALVULA = "Válvula"
PROP_INTERVENCAO = "Intervenção"
PROP_OBSERVACAO = "Observação"

MAX_VALVES = {"512": 175, "513": 175, "514": 72}
TYPE_MAP = {
    "corretiva": "corretiva",
    "preventiva": "preventiva",
    "diagnóstico": "inspecao",
    "diagnostico": "inspecao",
}


def notion_headers():
    return {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
    }


def txt(prop):
    if not prop:
        return ""
    prop_type = prop.get("type", "")
    return "".join(item.get("plain_text", "") for item in prop.get(prop_type, []))


def sel(prop):
    return ((prop or {}).get("select") or {}).get("name", "")


def msel(prop):
    return [item["name"] for item in (prop or {}).get("multi_select", [])]


def dat(prop):
    return ((prop or {}).get("date") or {}).get("start")


def normalize_timestamp(value):
    if not value:
        return datetime.now(timezone.utc).isoformat()
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def normalize_subset(component):
    value = (component or "Geral").strip()
    if value.casefold() in {"sonda", "jumper"}:
        return "SONDA"
    return value


def stable_record_id(page_id, subset):
    raw = f"{page_id}:{subset}".encode("utf-8")
    return "notion-" + hashlib.sha1(raw).hexdigest()[:20]


def record_value(record):
    fields = {
        "id": {"stringValue": record["id"]},
        "notionPageId": {"stringValue": record["notionPageId"]},
        "source": {"stringValue": "chatgpt_notion_dispatch"},
        "timestamp": {"stringValue": record["timestamp"]},
        "subset": {"stringValue": record["subset"]},
        "type": {"stringValue": record["type"]},
        "description": {"stringValue": record["description"]},
        "executante": {"stringValue": ""},
        "turno": {"stringValue": ""},
        "status": {"stringValue": record["status"]},
        "isCritical": {"booleanValue": False},
        "photos": {"arrayValue": {"values": []}},
    }
    return {"mapValue": {"fields": fields}}


def field_string(value, field_name):
    try:
        return (
            value["mapValue"]["fields"]
            .get(field_name, {})
            .get("stringValue", "")
        )
    except (KeyError, TypeError):
        return ""


def firebase_doc_url(line_id, valve_id):
    return f"{FIREBASE_ROOT}/lines/{line_id}/valves/{valve_id}?key={FIREBASE_KEY}"


def read_history(line_id, valve_id):
    response = requests.get(firebase_doc_url(line_id, valve_id), timeout=30)
    if response.status_code == 404:
        return [], None, response
    if response.status_code != 200:
        return None, None, response

    body = response.json()
    history = (
        body.get("fields", {})
        .get("historico", {})
        .get("arrayValue", {})
        .get("values", [])
    )
    return history, body.get("updateTime"), response


def commit_history(line_id, valve_id, history, update_time=None):
    doc_name = f"{DOC_BASE}/lines/{line_id}/valves/{valve_id}"
    write = {
        "update": {
            "name": doc_name,
            "fields": {
                "valveNumber": {"integerValue": int(valve_id)},
                "historico": {"arrayValue": {"values": history}},
            },
        },
        "updateMask": {"fieldPaths": ["valveNumber", "historico"]},
    }
    if update_time:
        write["currentDocument"] = {"updateTime": update_time}

    return requests.post(
        FIREBASE_COMMIT_URL,
        json={"writes": [write]},
        timeout=30,
    )


def replace_page_history(line_id, valve_id, page_id, records):
    last_response = None
    for attempt in range(1, 4):
        history, update_time, read_response = read_history(line_id, valve_id)
        if history is None:
            return read_response

        history = [
            value
            for value in history
            if field_string(value, "notionPageId") != page_id
        ]
        history.extend(record_value(record) for record in records)

        last_response = commit_history(line_id, valve_id, history, update_time)
        if last_response.status_code in (200, 201):
            return last_response

        if last_response.status_code in (409, 412) and attempt < 3:
            time.sleep(0.5 * attempt)
            continue
        return last_response

    return last_response


def remove_page_from_old_location(line_id, valve_id, page_id):
    for attempt in range(1, 4):
        history, update_time, read_response = read_history(line_id, valve_id)
        if history is None:
            return read_response

        cleaned = [
            value
            for value in history
            if field_string(value, "notionPageId") != page_id
        ]
        if len(cleaned) == len(history):
            return read_response

        response = commit_history(line_id, valve_id, cleaned, update_time)
        if response.status_code in (200, 201):
            return response
        if response.status_code in (409, 412) and attempt < 3:
            time.sleep(0.5 * attempt)
            continue
        return response

    return response


def index_url(page_id):
    return f"{FIREBASE_ROOT}/sync_index/{page_id}?key={FIREBASE_KEY}"


def read_index(page_id):
    response = requests.get(index_url(page_id), timeout=30)
    if response.status_code == 404:
        return None
    response.raise_for_status()
    fields = response.json().get("fields", {})
    return {
        "line": fields.get("line", {}).get("stringValue", ""),
        "valve": fields.get("valve", {}).get("stringValue", ""),
    }


def write_index(page_id, line_id, valve_id):
    name = f"{DOC_BASE}/sync_index/{page_id}"
    body = {
        "writes": [
            {
                "update": {
                    "name": name,
                    "fields": {
                        "line": {"stringValue": line_id},
                        "valve": {"stringValue": valve_id},
                        "updatedAt": {
                            "timestampValue": datetime.now(timezone.utc).isoformat()
                        },
                    },
                },
                "updateMask": {"fieldPaths": ["line", "valve", "updatedAt"]},
            }
        ]
    }
    return requests.post(FIREBASE_COMMIT_URL, json=body, timeout=30)


def fetch_notion_page(page_id):
    response = requests.get(
        f"https://api.notion.com/v1/pages/{page_id}",
        headers=notion_headers(),
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def build_records(page):
    props = page.get("properties", {})
    page_id = page.get("id", "")

    line_raw = sel(props.get("Linha")).strip()
    valve_raw = txt(props.get(PROP_VALVULA)).strip()
    type_raw = sel(props.get("Tipo")).strip()

    if not line_raw or not valve_raw:
        raise ValueError("Linha ou Válvula vazia")

    line_id = line_raw[1:] if line_raw.upper().startswith("L") else line_raw
    if line_id not in MAX_VALVES:
        raise ValueError(f"Linha não suportada: {line_raw}")

    if not re.fullmatch(r"\d+", valve_raw):
        raise ValueError(f"Válvula deve conter apenas número: {valve_raw}")

    valve_id = str(int(valve_raw))
    valve_number = int(valve_id)
    if valve_number < 1 or valve_number > MAX_VALVES[line_id]:
        raise ValueError(
            f"Válvula fora da faixa da L{line_id}: {valve_number} "
            f"(máx. {MAX_VALVES[line_id]})"
        )

    app_type = TYPE_MAP.get(type_raw.casefold())
    if not app_type:
        raise ValueError(f"Tipo não mapeado: {type_raw}")

    status_raw = sel(props.get("Status"))
    status = (
        "pendente"
        if "jumper" in status_raw.casefold() or "pend" in status_raw.casefold()
        else "ok"
    )

    timestamp = normalize_timestamp(
        dat(props.get("Data"))
        or page.get("last_edited_time")
        or page.get("created_time")
    )

    intervention = txt(props.get(PROP_INTERVENCAO))
    cause = txt(props.get("Causa"))
    observation = txt(props.get(PROP_OBSERVACAO))
    parts = (
        ([f"[{intervention}]"] if intervention else [])
        + ([cause] if cause else [])
        + ([observation] if observation else [])
    )
    description = " | ".join(parts) or "Manutenção"

    subsets = []
    for component in msel(props.get("Componente")) or ["Geral"]:
        subset = normalize_subset(component)
        if subset and subset not in subsets:
            subsets.append(subset)

    records = [
        {
            "id": stable_record_id(page_id, subset),
            "notionPageId": page_id,
            "timestamp": timestamp,
            "subset": subset,
            "type": app_type,
            "description": description,
            "status": status,
        }
        for subset in subsets
    ]

    return line_id, valve_id, records


def verify_page_history(line_id, valve_id, page_id, records):
    history, _, response = read_history(line_id, valve_id)
    if history is None:
        raise RuntimeError(
            f"Falha ao verificar Firebase: HTTP {response.status_code} "
            f"{response.text[:300]}"
        )

    page_items = [
        value
        for value in history
        if field_string(value, "notionPageId") == page_id
    ]
    if len(page_items) != len(records):
        raise RuntimeError(
            f"Verificação falhou: página {page_id} deveria ter {len(records)} "
            f"registro(s), mas o Firebase contém {len(page_items)}"
        )

    verified = []
    for record in records:
        matches = [
            value
            for value in page_items
            if field_string(value, "subset") == record["subset"]
        ]
        if len(matches) != 1:
            raise RuntimeError(
                f"Verificação falhou no subset {record['subset']}: "
                f"esperado 1 registro, encontrado {len(matches)}"
            )

        saved = matches[0]
        checks = {
            "id": record["id"],
            "type": record["type"],
            "description": record["description"],
            "status": record["status"],
        }
        for field_name, expected in checks.items():
            actual = field_string(saved, field_name)
            if actual != expected:
                raise RuntimeError(
                    f"Verificação falhou em {record['subset']}/{field_name}: "
                    f"esperado {expected!r}, encontrado {actual!r}"
                )

        verified.append(
            {
                "subset": record["subset"],
                "type": record["type"],
                "count": 1,
            }
        )

    indexed = read_index(page_id)
    if not indexed:
        raise RuntimeError("Verificação falhou: sync_index não encontrado")
    if indexed.get("line") != line_id or indexed.get("valve") != valve_id:
        raise RuntimeError(
            "Verificação falhou: sync_index aponta para "
            f"L{indexed.get('line')} V{indexed.get('valve')} em vez de "
            f"L{line_id} V{valve_id}"
        )

    return verified


def register_page(page_id):
    page = fetch_notion_page(page_id)
    canonical_page_id = page.get("id", page_id)
    line_id, valve_id, records = build_records(page)

    previous = read_index(canonical_page_id)
    if previous and (
        previous.get("line") != line_id or previous.get("valve") != valve_id
    ):
        old_line = previous.get("line", "")
        old_valve = previous.get("valve", "")
        if old_line in MAX_VALVES and old_valve.isdigit():
            response = remove_page_from_old_location(
                old_line, old_valve, canonical_page_id
            )
            if response.status_code not in (200, 201, 404):
                raise RuntimeError(
                    f"Falha ao remover local antigo: {response.status_code} "
                    f"{response.text[:300]}"
                )

    response = replace_page_history(
        line_id, valve_id, canonical_page_id, records
    )
    if response is None or response.status_code not in (200, 201):
        code = getattr(response, "status_code", "sem resposta")
        text = getattr(response, "text", "")[:500]
        raise RuntimeError(f"Firebase retornou {code}: {text}")

    index_response = write_index(canonical_page_id, line_id, valve_id)
    if index_response.status_code not in (200, 201):
        raise RuntimeError(
            f"Histórico salvo, mas índice falhou: {index_response.status_code} "
            f"{index_response.text[:300]}"
        )

    verified_records = verify_page_history(
        line_id, valve_id, canonical_page_id, records
    )

    print(
        f"VERIFICADO L{line_id} V{valve_id} "
        f"[{', '.join(r['subset'] for r in records)}] "
        f"page={canonical_page_id}"
    )

    return {
        "pageId": canonical_page_id,
        "line": line_id,
        "valve": valve_id,
        "records": verified_records,
    }


def write_result(path, data):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def main():
    dispatch_path = sys.argv[1] if len(sys.argv) > 1 else "maintenance_dispatch.json"
    result_path = (
        sys.argv[2] if len(sys.argv) > 2 else "maintenance_dispatch_status.json"
    )

    with open(dispatch_path, "r", encoding="utf-8") as handle:
        dispatch = json.load(handle)

    if not dispatch.get("enabled", False):
        print("Dispatch desativado: nada a registrar e status anterior preservado.")
        return

    page_id = str(dispatch.get("pageId", "")).strip()
    requested_at = str(dispatch.get("requestedAt", "")).strip()
    if not page_id:
        raise SystemExit("pageId ausente no dispatch")

    try:
        summary = register_page(page_id)
        result = {
            "status": "verified",
            "pageId": summary["pageId"],
            "requestedAt": requested_at,
            "verifiedAt": datetime.now(timezone.utc).isoformat(),
            "line": summary["line"],
            "valve": summary["valve"],
            "records": summary["records"],
            "message": "Firebase confirmado após leitura: exatamente um registro por subset.",
        }
        write_result(result_path, result)
    except Exception as exc:
        result = {
            "status": "failed",
            "pageId": page_id,
            "requestedAt": requested_at,
            "verifiedAt": datetime.now(timezone.utc).isoformat(),
            "error": str(exc),
        }
        write_result(result_path, result)
        raise


if __name__ == "__main__":
    main()
