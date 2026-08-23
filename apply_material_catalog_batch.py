# -*- coding: utf-8 -*-
"""Carga segura do catálogo mestre de materiais no Firestore, com releitura.

Não realiza consumo nem baixa de estoque. Registra somente cadastro técnico,
estoque/valor informado e referências de ordens SAP.
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
VALID_LINES = {"512", "513", "514"}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def safe_id(value):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", str(value).strip()).strip("-")


def url(path):
    return f"{ROOT}/{path}?key={FIREBASE_KEY}"


def get_doc(path):
    return requests.get(url(path), timeout=30)


def patch_doc(path, fields):
    return requests.patch(url(path), json={"fields": fields}, timeout=30)


def sv(v): return {"stringValue": str(v)}
def dv(v): return {"doubleValue": float(v)}
def iv(v): return {"integerValue": str(int(v))}
def bv(v): return {"booleanValue": bool(v)}
def nv(): return {"nullValue": None}
def av(values): return {"arrayValue": {"values": values}}
def strings(values): return av([sv(v) for v in values])


def decode_value(v):
    if "stringValue" in v: return v["stringValue"]
    if "doubleValue" in v: return float(v["doubleValue"])
    if "integerValue" in v: return int(v["integerValue"])
    if "booleanValue" in v: return bool(v["booleanValue"])
    if "nullValue" in v: return None
    if "arrayValue" in v: return [decode_value(x) for x in v.get("arrayValue", {}).get("values", [])]
    return None


def decode_fields(doc):
    return {k: decode_value(v) for k, v in doc.get("fields", {}).items()}


def unique(values):
    out = []
    for value in values or []:
        text = str(value).strip()
        if text and text not in out:
            out.append(text)
    return out


def existing_doc(path):
    r = get_doc(path)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def preserve(doc, name, fallback):
    if doc and name in doc.get("fields", {}):
        return doc["fields"][name]
    return fallback


def optional_number(item, key):
    value = item.get(key, None)
    if value is None or value == "":
        return None
    return float(value)


def optional_int(item, key):
    value = item.get(key, None)
    if value is None or value == "":
        return None
    return int(value)


def validate(cfg):
    if cfg.get("operation") != "material_catalog_batch_upsert":
        raise ValueError("operation não suportada")
    materials = cfg.get("materials")
    if not isinstance(materials, list) or not materials:
        raise ValueError("materials deve ser lista não vazia")
    seen = set()
    for m in materials:
        code = str(m.get("sapCode", "")).strip()
        desc = str(m.get("description", "")).strip()
        if not code or not desc:
            raise ValueError("todo material precisa de sapCode e description")
        if code in seen:
            raise ValueError(f"material duplicado: {code}")
        seen.add(code)
        lines = unique(m.get("applicableLines", []))
        if any(line not in VALID_LINES for line in lines):
            raise ValueError(f"linha inválida no material {code}")
    return materials


def apply(cfg):
    materials = validate(cfg)
    request_id = str(cfg.get("requestId", "")).strip()
    requested_at = str(cfg.get("requestedAt", "")).strip()
    source = str(cfg.get("source", "catalogo_visual_chatgpt")).strip() or "catalogo_visual_chatgpt"
    timestamp = now_iso()
    verified = []

    for item in materials:
        code = str(item["sapCode"]).strip()
        path = f"materials/{safe_id(code)}"
        old = existing_doc(path)
        old_dec = decode_fields(old) if old else {}
        lines = unique((old_dec.get("applicableLines") or []) + item.get("applicableLines", []))
        subsets = unique((old_dec.get("applicableSubsets") or []) + item.get("applicableSubsets", []))
        banners = unique((old_dec.get("bannerRefs") or []) + item.get("bannerRefs", []))
        applications = unique((old_dec.get("applicationNotes") or []) + item.get("applicationNotes", []))
        orders = unique((old_dec.get("referenceSapOrders") or []) + item.get("referenceSapOrders", []))

        fields = {
            "sapCode": sv(code),
            "description": sv(item["description"]),
            "manufacturerCode": sv(item.get("manufacturerCode", old_dec.get("manufacturerCode", ""))),
            "unit": sv(item.get("unit", old_dec.get("unit", "UN")) or "UN"),
            "applicableLines": strings(lines),
            "applicableSubsets": strings(subsets),
            "bannerRefs": strings(banners),
            "applicationNotes": strings(applications),
            "referenceSapOrders": strings(orders),
            "associationStatus": sv(item.get("associationStatus", old_dec.get("associationStatus", "confirmed"))),
            "active": bv(True),
            "source": sv(item.get("source", source)),
            "createdAt": preserve(old, "createdAt", sv(timestamp)),
            "updatedAt": sv(timestamp),
            "lastRequestId": sv(request_id),
        }

        for key in ("stockQty", "minStock", "unitCost"):
            value = optional_number(item, key)
            if value is not None:
                fields[key] = dv(value)
            elif old and key in old.get("fields", {}):
                fields[key] = old["fields"][key]

        for key in ("replacementIntervalHours", "replacementDueYear", "lastReferenceQty"):
            value = optional_int(item, key)
            if value is not None:
                fields[key] = iv(value)
            elif old and key in old.get("fields", {}):
                fields[key] = old["fields"][key]

        fields["currency"] = sv(item.get("currency", old_dec.get("currency", "BRL")) or "BRL")
        patch_doc(path, fields).raise_for_status()

        check = get_doc(path); check.raise_for_status()
        data = decode_fields(check.json())
        if data.get("sapCode") != code or data.get("lastRequestId") != request_id:
            raise RuntimeError(f"releitura não confirmou material {code}")
        verified.append({
            "sapCode": code,
            "description": data.get("description"),
            "lines": data.get("applicableLines") or [],
            "subsets": data.get("applicableSubsets") or [],
            "bannerRefs": data.get("bannerRefs") or [],
            "associationStatus": data.get("associationStatus"),
            "stockQty": data.get("stockQty"),
            "unitCost": data.get("unitCost"),
            "path": path,
        })

    order_refs = []
    for ref in cfg.get("orderReferences", []) or []:
        order = str(ref.get("sapOrderNumber", "")).strip()
        if not order:
            continue
        path = f"material_order_references/{safe_id(order)}"
        old = existing_doc(path)
        codes = unique(ref.get("materialCodes", []))
        items = unique(ref.get("items", []))
        fields = {
            "sapOrderNumber": sv(order),
            "description": sv(ref.get("description", "")),
            "plannedMaterialValue": dv(float(ref.get("plannedMaterialValue", 0) or 0)),
            "currency": sv(ref.get("currency", "BRL") or "BRL"),
            "materialCodes": strings(codes),
            "items": strings(items),
            "costStatus": sv("planejado_material"),
            "consumeOnlyOnMaintenance": bv(True),
            "source": sv(ref.get("source", source)),
            "createdAt": preserve(old, "createdAt", sv(timestamp)),
            "updatedAt": sv(timestamp),
            "lastRequestId": sv(request_id),
        }
        patch_doc(path, fields).raise_for_status()
        check = get_doc(path); check.raise_for_status()
        data = decode_fields(check.json())
        if data.get("sapOrderNumber") != order or data.get("lastRequestId") != request_id:
            raise RuntimeError(f"releitura não confirmou referência da ordem {order}")
        order_refs.append({"sapOrderNumber": order, "plannedMaterialValue": data.get("plannedMaterialValue"), "path": path})

    return {
        "status": "verified",
        "requestId": request_id,
        "requestedAt": requested_at,
        "operation": "material_catalog_batch_upsert",
        "materialsVerified": len(verified),
        "materials": verified,
        "orderReferences": order_refs,
        "consumeOnlyOnMaintenance": True,
        "verifiedAt": now_iso(),
        "message": "Catálogo de materiais relido e verificado no Firebase; nenhum consumo foi lançado."
    }


def write_status(path, payload):
    Path(path).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    dispatch_path = sys.argv[1] if len(sys.argv) > 1 else "material_catalog_dispatch.json"
    status_path = sys.argv[2] if len(sys.argv) > 2 else "material_catalog_status.json"
    cfg = json.loads(Path(dispatch_path).read_text(encoding="utf-8"))
    if not cfg.get("enabled", False):
        print("Carga do catálogo desativada.")
        return
    base = {"status":"running","requestId":str(cfg.get("requestId","")),"requestedAt":str(cfg.get("requestedAt","")),"operation":str(cfg.get("operation","")),"generatedAt":now_iso()}
    write_status(status_path, base)
    try:
        result = apply(cfg)
        write_status(status_path, result)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as exc:
        base.update({"status":"failed","error":str(exc),"verifiedAt":now_iso()})
        write_status(status_path, base)
        raise


if __name__ == "__main__":
    main()
