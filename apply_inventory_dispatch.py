# -*- coding: utf-8 -*-
"""Aplica cadastros de materiais no Firebase e confirma por releitura.

Sem credenciais no repositório. FIREBASE_KEY vem apenas de GitHub Secrets.
Operação suportada:
- material_profile_upsert: cadastra/atualiza materiais SAP e associa a um subconjunto/linhas.

Importante: associação não significa consumo. O consumo/custo realizado só deve ser lançado
quando uma manutenção preventiva ou corretiva for confirmada.
"""
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

FIREBASE_KEY = os.environ.get("FIREBASE_KEY", "")
PROJECT = os.environ.get("FIREBASE_PROJ", "sala-valvulas-ow-163b3")
ROOT = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents"
VALID_LINES = {"512", "513", "514"}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def safe_id(value):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", str(value).strip()).strip("-")


def url(path):
    if not FIREBASE_KEY:
        raise RuntimeError("FIREBASE_KEY ausente")
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


def write_status(path, payload):
    Path(path).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def unique(values):
    out = []
    for value in values or []:
        text = str(value).strip()
        if text and text not in out:
            out.append(text)
    return out


def existing_fields(path):
    r = get_doc(path)
    if r.status_code == 404:
        return {}, None
    r.raise_for_status()
    doc = r.json()
    return dict(doc.get("fields", {})), doc


def validate_material_profile(cfg):
    if cfg.get("operation") != "material_profile_upsert":
        raise ValueError("operation não suportada")

    profile_id = safe_id(cfg.get("profileId", ""))
    subset = str(cfg.get("subset", "")).strip()
    lines = unique(cfg.get("lines", []))
    materials = cfg.get("materials", [])
    reference_value = float(cfg.get("referencePlannedMaterialValue", 0) or 0)

    if not profile_id:
        raise ValueError("profileId obrigatório")
    if not subset:
        raise ValueError("subset obrigatório")
    if not lines or any(line not in VALID_LINES for line in lines):
        raise ValueError("lines inválidas")
    if not isinstance(materials, list) or not materials:
        raise ValueError("materials deve ser lista não vazia")
    if reference_value < 0:
        raise ValueError("referencePlannedMaterialValue inválido")

    seen = set()
    normalized = []
    for item in materials:
        if not isinstance(item, dict):
            raise ValueError("material inválido")
        code = str(item.get("sapCode", "")).strip()
        description = str(item.get("description", "")).strip()
        unit = str(item.get("unit", "UN")).strip() or "UN"
        qty = int(item.get("referenceQty", 0) or 0)
        if not code or not description:
            raise ValueError("sapCode e description são obrigatórios")
        if qty < 0:
            raise ValueError("referenceQty inválido")
        if code in seen:
            raise ValueError(f"material duplicado: {code}")
        seen.add(code)
        normalized.append({"sapCode": code, "description": description, "unit": unit, "referenceQty": qty})

    return profile_id, subset, lines, normalized, reference_value


def apply_material_profile(cfg):
    profile_id, subset, lines, materials, reference_value = validate_material_profile(cfg)
    request_id = str(cfg.get("requestId", "")).strip()
    requested_at = str(cfg.get("requestedAt", "")).strip()
    reference_order = str(cfg.get("referenceSapOrder", "")).strip()
    currency = str(cfg.get("currency", "BRL")).strip() or "BRL"
    source = str(cfg.get("source", "sap_component_screen_chatgpt")).strip() or "sap_component_screen_chatgpt"
    timestamp = now_iso()

    material_paths = []
    for item in materials:
        code = item["sapCode"]
        path = f"materials/{safe_id(code)}"
        fields, doc = existing_fields(path)
        current = decode_fields(doc) if doc else {}
        linked_lines = unique((current.get("applicableLines") or []) + lines)
        linked_subsets = unique((current.get("applicableSubsets") or []) + [subset])
        reference_orders = unique((current.get("referenceSapOrders") or []) + ([reference_order] if reference_order else []))

        fields.update({
            "sapCode": sv(code),
            "description": sv(item["description"]),
            "unit": sv(item["unit"]),
            "applicableLines": strings(linked_lines),
            "applicableSubsets": strings(linked_subsets),
            "referenceSapOrders": strings(reference_orders),
            "lastReferenceQty": iv(item["referenceQty"]),
            "source": sv(source),
            "active": bv(True),
            "createdAt": fields.get("createdAt", sv(timestamp)),
            "updatedAt": sv(timestamp),
            "lastRequestId": sv(request_id),
        })
        patch_doc(path, fields).raise_for_status()
        material_paths.append(path)

    profile_path = f"maintenance_material_profiles/{profile_id}"
    profile_fields, _ = existing_fields(profile_path)
    material_codes = [m["sapCode"] for m in materials]
    reference_items = [f"{m['sapCode']}|{m['description']}|{m['referenceQty']}|{m['unit']}" for m in materials]
    profile_fields.update({
        "profileId": sv(profile_id),
        "subset": sv(subset),
        "lines": strings(lines),
        "materialCodes": strings(material_codes),
        "referenceItems": strings(reference_items),
        "referenceSapOrder": sv(reference_order),
        "referencePlannedMaterialValue": dv(reference_value),
        "currency": sv(currency),
        "recipeConfirmed": bv(False),
        "costMode": sv("reference_order_total"),
        "consumeOnlyOnMaintenance": bv(True),
        "note": sv("Materiais associados ao subconjunto; não consumir nem lançar custo até manutenção preventiva/corretiva ser confirmada."),
        "source": sv(source),
        "createdAt": profile_fields.get("createdAt", sv(timestamp)),
        "updatedAt": sv(timestamp),
        "lastRequestId": sv(request_id),
    })
    patch_doc(profile_path, profile_fields).raise_for_status()

    verified_materials = []
    for item, path in zip(materials, material_paths):
        check = get_doc(path); check.raise_for_status()
        data = decode_fields(check.json())
        if data.get("sapCode") != item["sapCode"]:
            raise RuntimeError(f"releitura não confirmou material {item['sapCode']}")
        if subset not in (data.get("applicableSubsets") or []):
            raise RuntimeError(f"releitura não confirmou Tulipa no material {item['sapCode']}")
        if any(line not in (data.get("applicableLines") or []) for line in lines):
            raise RuntimeError(f"releitura não confirmou linhas do material {item['sapCode']}")
        verified_materials.append({
            "sapCode": data.get("sapCode"),
            "description": data.get("description"),
            "unit": data.get("unit"),
            "referenceQty": data.get("lastReferenceQty"),
            "path": path,
        })

    profile_check = get_doc(profile_path); profile_check.raise_for_status()
    p = decode_fields(profile_check.json())
    if p.get("subset") != subset or p.get("lines") != lines or p.get("materialCodes") != material_codes:
        raise RuntimeError("releitura não confirmou o perfil de materiais")
    if abs(float(p.get("referencePlannedMaterialValue") or 0) - reference_value) > 0.001:
        raise RuntimeError("releitura não confirmou o valor de referência")
    if p.get("consumeOnlyOnMaintenance") is not True:
        raise RuntimeError("releitura não confirmou regra de consumo")

    return {
        "status": "verified",
        "requestId": request_id,
        "requestedAt": requested_at,
        "operation": "material_profile_upsert",
        "profileId": profile_id,
        "profilePath": profile_path,
        "subset": subset,
        "lines": lines,
        "materials": verified_materials,
        "referenceSapOrder": reference_order,
        "referencePlannedMaterialValue": reference_value,
        "currency": currency,
        "recipeConfirmed": False,
        "consumeOnlyOnMaintenance": True,
        "verifiedAt": now_iso(),
        "message": "Materiais SAP e associação ao subconjunto foram relidos e verificados no Firebase; nenhum consumo foi lançado."
    }


def main():
    dispatch_path = sys.argv[1] if len(sys.argv) > 1 else "inventory_dispatch.json"
    status_path = sys.argv[2] if len(sys.argv) > 2 else "inventory_dispatch_status.json"
    cfg = json.loads(Path(dispatch_path).read_text(encoding="utf-8"))
    if not cfg.get("enabled", False):
        print("Dispatch de materiais desativado.")
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
        result = apply_material_profile(cfg)
        write_status(status_path, result)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as exc:
        base.update({"status": "failed", "error": str(exc), "verifiedAt": now_iso()})
        write_status(status_path, base)
        raise


if __name__ == "__main__":
    main()
