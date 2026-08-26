# -*- coding: utf-8 -*-
"""Atualiza e verifica o sonda_status operacional de válvulas no Firestore."""
import json
import os
import re
import sys
from datetime import datetime, timezone

import requests

FIREBASE_KEY = os.environ["FIREBASE_KEY"]
FIREBASE_PROJ = os.environ.get("FIREBASE_PROJ", "sala-valvulas-ow-163b3")
ROOT = f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJ}/databases/(default)/documents"
MAX_VALVES = {"512": 175, "513": 175}
ALLOWED_STATUS = {"ok", "jumpeada"}


def s(value):
    return {"stringValue": str(value)}


def doc_url(path):
    return f"{ROOT}/{path}?key={FIREBASE_KEY}"


def patch_status(line, valve, status):
    url = doc_url(f"lines/{line}/valves/{valve}") + "&updateMask.fieldPaths=sonda_status"
    r = requests.patch(url, json={"fields": {"sonda_status": s(status)}}, timeout=30)
    if r.status_code not in (200, 201):
        raise RuntimeError(f"Falha ao atualizar L{line} V{valve}: {r.status_code} {r.text[:300]}")


def read_status(line, valve):
    r = requests.get(doc_url(f"lines/{line}/valves/{valve}"), timeout=30)
    r.raise_for_status()
    return r.json().get("fields", {}).get("sonda_status", {}).get("stringValue", "")


def validate_item(item):
    line = str(item.get("line", "")).strip().lstrip("Ll")
    valve_raw = str(item.get("valve", "")).strip()
    status = str(item.get("status", "")).strip().casefold()
    if line not in MAX_VALVES:
        raise ValueError(f"Linha não suportada para gestão de sonda: {line}")
    if not re.fullmatch(r"\d+", valve_raw):
        raise ValueError(f"Válvula inválida: {valve_raw}")
    valve = str(int(valve_raw))
    if not 1 <= int(valve) <= MAX_VALVES[line]:
        raise ValueError(f"Válvula fora da faixa da L{line}: {valve}")
    if status not in ALLOWED_STATUS:
        raise ValueError(f"Status de sonda inválido: {status}")
    return line, valve, status


def write_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def main():
    dispatch_path = sys.argv[1] if len(sys.argv) > 1 else "sonda_status_dispatch.json"
    result_path = sys.argv[2] if len(sys.argv) > 2 else "sonda_status_dispatch_status.json"
    with open(dispatch_path, encoding="utf-8") as f:
        dispatch = json.load(f)
    if not dispatch.get("enabled", False):
        print("Dispatch de sonda desativado: nada a alterar.")
        return

    requested = str(dispatch.get("requestedAt", "")).strip()
    items = dispatch.get("items") or []
    if not items:
        raise SystemExit("Nenhum item no dispatch de sonda")

    verified = []
    try:
        for raw in items:
            line, valve, status = validate_item(raw)
            patch_status(line, valve, status)
            actual = read_status(line, valve)
            if actual != status:
                raise RuntimeError(f"Verificação falhou L{line} V{valve}: esperado {status}, encontrado {actual}")
            verified.append({"line": line, "valve": valve, "sonda_status": actual})
        write_json(result_path, {
            "status": "verified",
            "requestedAt": requested,
            "verifiedAt": datetime.now(timezone.utc).isoformat(),
            "items": verified,
            "message": "sonda_status confirmado após releitura do Firebase."
        })
    except Exception as exc:
        write_json(result_path, {
            "status": "failed",
            "requestedAt": requested,
            "verifiedAt": datetime.now(timezone.utc).isoformat(),
            "error": str(exc)
        })
        raise


if __name__ == "__main__":
    main()
