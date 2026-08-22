# -*- coding: utf-8 -*-
"""Normaliza rótulos de componente no histórico V2.

Escopo propositalmente conservador: somente variantes de capitalização de
"Sonda" são convertidas para o rótulo canônico "SONDA". Cada alteração é
re-lida do Firestore antes de confirmar sucesso.
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
LINES = ["512", "513", "514"]
CANONICAL = "SONDA"


def url(path):
    return f"{ROOT}/{path}?key={FIREBASE_KEY}"


def list_collection(path, page_size=500):
    out, token = [], None
    while True:
        u = f"{ROOT}/{path}?pageSize={page_size}&key={FIREBASE_KEY}"
        if token:
            u += f"&pageToken={token}"
        r = requests.get(u, timeout=30)
        if r.status_code == 404:
            return []
        r.raise_for_status()
        body = r.json()
        out.extend(body.get("documents", []))
        token = body.get("nextPageToken")
        if not token:
            return out


def field_string(fields, name):
    return fields.get(name, {}).get("stringValue", "")


def patch_subset(path, value):
    u = f"{ROOT}/{path}?updateMask.fieldPaths=subset&updateMask.fieldPaths=updatedAt&key={FIREBASE_KEY}"
    payload = {"fields": {"subset": {"stringValue": value}, "updatedAt": {"stringValue": datetime.now(timezone.utc).isoformat()}}}
    r = requests.patch(u, json=payload, timeout=30)
    r.raise_for_status()


def get_doc(path):
    r = requests.get(url(path), timeout=30)
    r.raise_for_status()
    return r.json()


def collect_candidates():
    candidates = []
    counts_before = {}
    for line in LINES:
        for valve_doc in list_collection(f"lines/{line}/valves", 300):
            valve = valve_doc["name"].split("/")[-1]
            for hdoc in list_collection(f"lines/{line}/valves/{valve}/history", 500):
                fields = hdoc.get("fields", {})
                subset = field_string(fields, "subset").strip()
                if subset:
                    counts_before[subset] = counts_before.get(subset, 0) + 1
                if subset.casefold() == "sonda" and subset != CANONICAL:
                    hid = hdoc["name"].split("/")[-1]
                    candidates.append({"line": line, "valve": valve, "id": hid, "from": subset, "path": f"lines/{line}/valves/{valve}/history/{hid}"})
    return candidates, counts_before


def count_sonda_variants():
    variants = {}
    total = 0
    for line in LINES:
        for valve_doc in list_collection(f"lines/{line}/valves", 300):
            valve = valve_doc["name"].split("/")[-1]
            for hdoc in list_collection(f"lines/{line}/valves/{valve}/history", 500):
                subset = field_string(hdoc.get("fields", {}), "subset").strip()
                if subset.casefold() == "sonda":
                    variants[subset] = variants.get(subset, 0) + 1
                    total += 1
    return variants, total


def main():
    cfg_path = Path(sys.argv[1] if len(sys.argv) > 1 else "component_normalization.json")
    status_path = Path(sys.argv[2] if len(sys.argv) > 2 else "component_normalization_status.json")
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    if not cfg.get("enabled", False):
        print("Normalização desativada.")
        return
    apply = bool(cfg.get("apply", False))
    requested = str(cfg.get("requestedAt", ""))
    candidates, counts_before = collect_candidates()
    result = {
        "status": "dry_run" if not apply else "running",
        "requestedAt": requested,
        "canonicalLabel": CANONICAL,
        "candidates": len(candidates),
        "before": {k: v for k, v in counts_before.items() if k.casefold() == "sonda"},
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }
    status_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not apply:
        return

    for item in candidates:
        patch_subset(item["path"], CANONICAL)
        reread = get_doc(item["path"])
        actual = field_string(reread.get("fields", {}), "subset")
        if actual != CANONICAL:
            raise RuntimeError(f"Falha de verificação em {item['path']}: {actual!r}")

    variants_after, total_after = count_sonda_variants()
    noncanonical = {k: v for k, v in variants_after.items() if k != CANONICAL}
    if noncanonical:
        raise RuntimeError(f"Ainda existem variantes não canônicas: {noncanonical}")

    result.update({
        "status": "verified",
        "updatedDocuments": len(candidates),
        "after": variants_after,
        "totalSonda": total_after,
        "verifiedAt": datetime.now(timezone.utc).isoformat(),
        "message": "Rótulos de Sonda normalizados e verificados no histórico V2."
    })
    status_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(result["message"])


if __name__ == "__main__":
    main()
