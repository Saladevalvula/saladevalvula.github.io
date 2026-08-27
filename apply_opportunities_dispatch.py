# -*- coding: utf-8 -*-
"""Cria/atualiza oportunidades no Firestore e confirma por releitura."""
import json
import os
import re
import sys
from datetime import datetime, timezone

import requests

FIREBASE_KEY = os.environ["FIREBASE_KEY"]
FIREBASE_PROJ = os.environ.get("FIREBASE_PROJ", "sala-valvulas-ow-163b3")
ROOT = f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJ}/databases/(default)/documents"
MAX_VALVES = {"512": 175, "513": 175, "514": 72}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def s(v): return {"stringValue": str(v)}
def i(v): return {"integerValue": str(int(v))}


def doc_url(path):
    return f"{ROOT}/{path}?key={FIREBASE_KEY}"


def get_doc(path):
    return requests.get(doc_url(path), timeout=30)


def patch_doc(path, fields):
    return requests.patch(doc_url(path), json={"fields": fields}, timeout=30)


def field_string(doc, name):
    return doc.get("fields", {}).get(name, {}).get("stringValue", "")


def field_int(doc, name):
    raw = doc.get("fields", {}).get(name, {}).get("integerValue", "0")
    return int(raw)


def safe_id(value):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", str(value).strip()).strip("-")


def validate_item(raw):
    line = str(raw.get("line", "")).strip().lstrip("Ll")
    valve_raw = str(raw.get("valve", "")).strip()
    subset = str(raw.get("subset", "")).strip()
    text = str(raw.get("text", "")).strip()
    if line not in MAX_VALVES:
        raise ValueError(f"Linha inválida: {line}")
    if not re.fullmatch(r"\d+", valve_raw):
        raise ValueError(f"Válvula inválida: {valve_raw}")
    valve = int(valve_raw)
    if not 1 <= valve <= MAX_VALVES[line]:
        raise ValueError(f"Válvula fora da faixa da L{line}: {valve}")
    if not subset or not text:
        raise ValueError("subset e text são obrigatórios")
    return line, valve, subset, text


def main():
    dispatch_path = sys.argv[1] if len(sys.argv) > 1 else "opportunities_dispatch.json"
    result_path = sys.argv[2] if len(sys.argv) > 2 else "opportunities_dispatch_status.json"
    with open(dispatch_path, encoding="utf-8") as f:
        cfg = json.load(f)
    if not cfg.get("enabled", False):
        print("Dispatch de oportunidades desativado.")
        return

    request_id = str(cfg.get("requestId", "")).strip()
    requested_at = str(cfg.get("requestedAt", "")).strip()
    items = cfg.get("items") or []
    if not items:
        raise SystemExit("Nenhuma oportunidade informada")

    verified = []
    try:
        for raw in items:
            line, valve, subset, text = validate_item(raw)
            key = str(raw.get("key", "")).strip() or f"pcm-L{line}-V{valve}-{subset}"
            doc_id = safe_id(key)
            if not doc_id:
                raise ValueError("ID de oportunidade inválido")
            path = f"oportunidades/{doc_id}"
            existing = get_doc(path)
            created_at = now_iso()
            if existing.status_code == 200:
                created_at = field_string(existing.json(), "createdAt") or created_at
            elif existing.status_code != 404:
                existing.raise_for_status()

            fields = {
                "linha": s(line),
                "nome": s(str(raw.get("name", "PCM")).strip() or "PCM"),
                "turno": s(str(raw.get("shift", "A definir")).strip() or "A definir"),
                "texto": s(text),
                "valvula": i(valve),
                "subset": s(subset),
                "categoria": s("PCM"),
                "status": s("aberta"),
                "source": s("chatgpt_pcm_dispatch"),
                "notionPageId": s(str(raw.get("notionPageId", "")).strip()),
                "requestId": s(request_id),
                "createdAt": s(created_at),
                "updatedAt": s(now_iso()),
            }
            r = patch_doc(path, fields)
            if r.status_code not in (200, 201):
                raise RuntimeError(f"Falha ao gravar {path}: {r.status_code} {r.text[:300]}")

            check = get_doc(path)
            check.raise_for_status()
            doc = check.json()
            if not (
                field_string(doc, "linha") == line
                and field_int(doc, "valvula") == valve
                and field_string(doc, "subset") == subset
                and field_string(doc, "texto") == text
                and field_string(doc, "status") == "aberta"
            ):
                raise RuntimeError(f"Releitura não confirmou {path}")
            verified.append({"id": doc_id, "line": line, "valve": str(valve), "subset": subset, "text": text, "status": "aberta"})

        result = {
            "status": "verified",
            "requestId": request_id,
            "requestedAt": requested_at,
            "verifiedAt": now_iso(),
            "items": verified,
            "message": "Oportunidades PCM confirmadas após releitura do Firebase."
        }
    except Exception as exc:
        result = {
            "status": "failed",
            "requestId": request_id,
            "requestedAt": requested_at,
            "verifiedAt": now_iso(),
            "error": str(exc)
        }
        with open(result_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2); f.write("\n")
        raise

    with open(result_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2); f.write("\n")


if __name__ == "__main__":
    main()
