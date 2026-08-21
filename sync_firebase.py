# -*- coding: utf-8 -*-
import hashlib
import os
import re
import sys
import time
from datetime import datetime, timezone

import requests

NOTION_TOKEN = os.environ["NOTION_TOKEN"]
NOTION_DB_ID = os.environ.get("NOTION_DB_ID", "82e7f043-0a3f-4609-8853-a32d96f7a7d2")
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

VALID_LINES = {"512", "513", "514"}
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
    # Sonda/Jumper continuam usando o fluxo especial existente do app.
    # MC9 e EA10 permanecem com seus próprios nomes.
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


def notion_page_id_from_history_value(value):
    try:
        return (
            value["mapValue"]["fields"]
            .get("notionPageId", {})
            .get("stringValue", "")
        )
    except (KeyError, TypeError):
        return ""


def firebase_doc_url(line_id, valve_id):
    return f"{FIREBASE_ROOT}/lines/{line_id}/valves/{valve_id}?key={FIREBASE_KEY}"


def replace_page_history(line_id, valve_id, page_id, records):
    """Substitui os itens daquela página do Notion sem duplicar o histórico."""
    doc_name = f"{DOC_BASE}/lines/{line_id}/valves/{valve_id}"
    last_response = None

    for attempt in range(1, 4):
        current = requests.get(firebase_doc_url(line_id, valve_id), timeout=30)

        if current.status_code == 200:
            current_json = current.json()
            current_fields = current_json.get("fields", {})
            history = (
                current_fields.get("historico", {})
                .get("arrayValue", {})
                .get("values", [])
            )
            update_time = current_json.get("updateTime")
        elif current.status_code == 404:
            history = []
            update_time = None
        else:
            return current

        # Remove a versão anterior desta mesma página. Assim uma edição
        # (ex.: Sonda -> MC9) substitui o item em vez de criar duplicata.
        history = [
            value
            for value in history
            if notion_page_id_from_history_value(value) != page_id
        ]
        history.extend(record_value(record) for record in records)

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

        last_response = requests.post(
            FIREBASE_COMMIT_URL,
            json={"writes": [write]},
            timeout=30,
        )

        if last_response.status_code in (200, 201):
            return last_response

        # Se alguém gravou na mesma válvula entre o GET e o commit,
        # relê o documento e tenta novamente para não apagar registro alheio.
        if last_response.status_code in (409, 412) and attempt < 3:
            time.sleep(0.5 * attempt)
            continue

        return last_response

    return last_response


def sync(limit=50):
    print(f"Buscando até {limit} registros editados recentemente no Notion...")

    response = requests.post(
        f"https://api.notion.com/v1/databases/{NOTION_DB_ID}/query",
        headers=notion_headers(),
        json={
            "page_size": limit,
            "sorts": [
                {"timestamp": "last_edited_time", "direction": "descending"}
            ],
        },
        timeout=30,
    )
    response.raise_for_status()

    pages = response.json().get("results", [])
    print(f"{len(pages)} encontrados")

    ok = err = skip = 0

    for page in pages:
        props = page.get("properties", {})
        page_id = page.get("id", "")

        line_raw = sel(props.get("Linha")).strip()
        valve_raw = txt(props.get(PROP_VALVULA)).strip()
        type_raw = sel(props.get("Tipo")).strip()

        if not line_raw or not valve_raw:
            print(f"  SKIP {page_id}: Linha ou Válvula vazia")
            skip += 1
            continue

        line_id = line_raw[1:] if line_raw.upper().startswith("L") else line_raw
        if line_id not in VALID_LINES:
            print(f"  SKIP {page_id}: Linha não suportada ({line_raw})")
            skip += 1
            continue

        if not re.fullmatch(r"\d+", valve_raw):
            print(f"  SKIP {page_id}: Válvula deve ser apenas número ({valve_raw})")
            skip += 1
            continue

        valve_id = str(int(valve_raw))
        if int(valve_id) <= 0:
            print(f"  SKIP {page_id}: Válvula inválida ({valve_raw})")
            skip += 1
            continue

        app_type = TYPE_MAP.get(type_raw.casefold())
        if not app_type:
            print(f"  SKIP {page_id}: Tipo não mapeado ({type_raw})")
            skip += 1
            continue

        status_raw = sel(props.get("Status"))
        status = (
            "pendente"
            if "jumper" in status_raw.casefold() or "pend" in status_raw.casefold()
            else "ok"
        )

        date_value = dat(props.get("Data"))
        timestamp = normalize_timestamp(
            date_value or page.get("last_edited_time") or page.get("created_time")
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

        components = msel(props.get("Componente")) or ["Geral"]
        subsets = []
        for component in components:
            subset = normalize_subset(component)
            if subset not in subsets:
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

        firebase_response = replace_page_history(
            line_id, valve_id, page_id, records
        )

        if firebase_response is not None and firebase_response.status_code in (200, 201):
            print(
                f"  OK   L{line_id} V{valve_id} "
                f"[{', '.join(subsets)}]"
            )
            ok += len(records)
        else:
            status_code = getattr(firebase_response, "status_code", "sem resposta")
            body = getattr(firebase_response, "text", "")[:500].replace("\n", " ")
            print(
                f"  ERR  L{line_id} V{valve_id} [{', '.join(subsets)}] "
                f"-> {status_code}: {body}"
            )
            err += 1

    print(f"OK:{ok} Err:{err} Skip:{skip}")

    if err:
        raise SystemExit(1)


if __name__ == "__main__":
    sync(int(sys.argv[1]) if len(sys.argv) > 1 else 50)
