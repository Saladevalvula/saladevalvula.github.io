# -*- coding: utf-8 -*-
import hashlib
import os
import re
import sys
from datetime import datetime, timezone

import requests

NOTION_TOKEN = os.environ["NOTION_TOKEN"]
NOTION_DB_ID = os.environ.get("NOTION_DB_ID", "82e7f043-0a3f-4609-8853-a32d96f7a7d2")
FIREBASE_KEY = os.environ["FIREBASE_KEY"]
FIREBASE_PROJ = os.environ.get("FIREBASE_PROJ", "sala-valvulas-ow-163b3")
FIREBASE_URL = (
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


def hdr():
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


def build_body(line_id, valve_id, rec):
    doc = f"{DOC_BASE}/lines/{line_id}/valves/{valve_id}"
    fields = {
        "id": {"stringValue": rec["id"]},
        "notionPageId": {"stringValue": rec["notionPageId"]},
        "timestamp": {"stringValue": rec["timestamp"]},
        "subset": {"stringValue": rec["subset"]},
        "type": {"stringValue": rec["type"]},
        "description": {"stringValue": rec["description"]},
        "executante": {"stringValue": ""},
        "turno": {"stringValue": ""},
        "status": {"stringValue": rec["status"]},
        "isCritical": {"booleanValue": False},
        "photos": {"arrayValue": {"values": []}},
    }

    return {
        "writes": [
            {
                "update": {
                    "name": doc,
                    "fields": {"valveNumber": {"integerValue": int(valve_id)}},
                },
                "updateMask": {"fieldPaths": ["valveNumber"]},
            },
            {
                "transform": {
                    "document": doc,
                    "fieldTransforms": [
                        {
                            "fieldPath": "historico",
                            "appendMissingElements": {
                                "values": [{"mapValue": {"fields": fields}}]
                            },
                        }
                    ],
                }
            },
        ]
    }


def sync(limit=50):
    print(f"Buscando até {limit} registros editados recentemente no Notion...")

    response = requests.post(
        f"https://api.notion.com/v1/databases/{NOTION_DB_ID}/query",
        headers=hdr(),
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

        for component in components:
            subset = normalize_subset(component)
            record = {
                "id": stable_record_id(page_id, subset),
                "notionPageId": page_id,
                "timestamp": timestamp,
                "subset": subset,
                "type": app_type,
                "description": description,
                "status": status,
            }

            firebase_response = requests.post(
                FIREBASE_URL,
                json=build_body(line_id, valve_id, record),
                timeout=30,
            )

            if firebase_response.status_code in (200, 201):
                print(f"  OK   L{line_id} V{valve_id} [{subset}]")
                ok += 1
            else:
                body = firebase_response.text[:500].replace("\n", " ")
                print(
                    f"  ERR  L{line_id} V{valve_id} [{subset}] "
                    f"-> {firebase_response.status_code}: {body}"
                )
                err += 1

    print(f"OK:{ok} Err:{err} Skip:{skip}")

    if err:
        raise SystemExit(1)


if __name__ == "__main__":
    sync(int(sys.argv[1]) if len(sys.argv) > 1 else 50)
