# -*- coding: utf-8 -*-
"""Correlaciona histórico de manutenções com o catálogo de materiais.

Objetivo:
- vincular materiais já mapeados aos registros corretivos/preventivos existentes;
- calcular um custo retroativo estimado quando há base de preço confiável;
- preservar a data original da manutenção e congelar a referência de custo usada;
- nunca baixar estoque nesta rotina.

A estimativa usa uma destas bases:
1. perfil de materiais com valor total de ordem e lote uniforme (ex.: Tulipa: valor/7);
2. soma dos valores unitários atuais dos materiais confirmados para o subconjunto,
   assumindo 1 unidade por material quando não existe receita confirmada.

O resultado é explicitamente marcado como estimativa retroativa, nunca como custo SAP real.
"""
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import requests

FIREBASE_KEY = os.environ["FIREBASE_KEY"]
PROJECT = os.environ.get("FIREBASE_PROJ", "sala-valvulas-ow-163b3")
API = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents"
RUN_QUERY = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents:runQuery"
VALID_LINES = {"512", "513", "514"}
VALID_TYPES = {"corretiva", "preventiva"}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def sv(v): return {"stringValue": str(v)}
def dv(v): return {"doubleValue": float(v)}
def iv(v): return {"integerValue": str(int(v))}
def bv(v): return {"booleanValue": bool(v)}
def av(values): return {"arrayValue": {"values": values}}
def strings(values): return av([sv(v) for v in values])


def decode_value(v):
    if "stringValue" in v: return v["stringValue"]
    if "timestampValue" in v: return v["timestampValue"]
    if "integerValue" in v: return int(v["integerValue"])
    if "doubleValue" in v: return float(v["doubleValue"])
    if "booleanValue" in v: return bool(v["booleanValue"])
    if "nullValue" in v: return None
    if "arrayValue" in v: return [decode_value(x) for x in v.get("arrayValue", {}).get("values", [])]
    if "mapValue" in v: return {k: decode_value(x) for k, x in v.get("mapValue", {}).get("fields", {}).items()}
    return None


def decode_fields(doc):
    return {k: decode_value(v) for k, v in doc.get("fields", {}).items()}


def normalize_subset(value):
    text = str(value or "").strip().upper()
    text = text.replace(" ", "")
    text = text.replace("V5-V6", "V5/V6").replace("V5V6", "V5/V6")
    return text


def normalize_type(value):
    return str(value or "").strip().lower()


def doc_path_from_name(name):
    marker = "/documents/"
    return name.split(marker, 1)[1] if marker in name else name


def get_collection(collection_id):
    out = []
    token = None
    while True:
        params = {"key": FIREBASE_KEY, "pageSize": 1000}
        if token:
            params["pageToken"] = token
        r = requests.get(f"{API}/{collection_id}", params=params, timeout=45)
        r.raise_for_status()
        payload = r.json()
        out.extend(payload.get("documents", []))
        token = payload.get("nextPageToken")
        if not token:
            return out


def get_all_history():
    body = {
        "structuredQuery": {
            "from": [{"collectionId": "history", "allDescendants": True}],
            "orderBy": [{"field": {"fieldPath": "__name__"}, "direction": "ASCENDING"}],
        }
    }
    r = requests.post(RUN_QUERY, params={"key": FIREBASE_KEY}, json=body, timeout=90)
    r.raise_for_status()
    docs = []
    for row in r.json():
        if "document" not in row:
            continue
        doc = row["document"]
        path = doc_path_from_name(doc.get("name", ""))
        # Só histórico de válvulas: lines/{linha}/valves/{valvula}/history/{id}
        parts = path.split("/")
        if len(parts) == 6 and parts[0] == "lines" and parts[2] == "valves" and parts[4] == "history":
            docs.append(doc)
    return docs


def patch_full_doc(path, fields):
    r = requests.patch(f"{API}/{path}", params={"key": FIREBASE_KEY}, json={"fields": fields}, timeout=45)
    r.raise_for_status()
    return r.json()


def material_index(material_docs):
    rows = []
    for doc in material_docs:
        d = decode_fields(doc)
        if d.get("active") is False or str(d.get("aliasOf") or "").strip():
            continue
        status = str(d.get("associationStatus") or "")
        if status.startswith("pending") or status == "line_pending":
            continue
        code = str(d.get("sapCode") or "").strip()
        if not code:
            continue
        rows.append({
            "code": code,
            "description": str(d.get("description") or ""),
            "lines": {str(x) for x in (d.get("applicableLines") or [])},
            "subsets": {normalize_subset(x) for x in (d.get("applicableSubsets") or [])},
            "unitCost": float(d.get("unitCost") or 0),
            "currency": str(d.get("currency") or "BRL"),
        })
    return rows


def profile_index(profile_docs):
    profiles = []
    for doc in profile_docs:
        d = decode_fields(doc)
        value = float(d.get("referencePlannedMaterialValue") or 0)
        subset = normalize_subset(d.get("subset"))
        lines = {str(x) for x in (d.get("lines") or [])}
        refs = d.get("referenceItems") or []
        quantities = []
        codes = []
        for item in refs:
            parts = str(item).split("|")
            if parts:
                codes.append(parts[0].strip())
            if len(parts) >= 3:
                try:
                    q = int(float(parts[2]))
                    if q > 0:
                        quantities.append(q)
                except Exception:
                    pass
        batch_count = quantities[0] if quantities and all(q == quantities[0] for q in quantities) else 0
        unit_profile_cost = value / batch_count if value > 0 and batch_count > 0 else 0
        profiles.append({
            "subset": subset,
            "lines": lines,
            "materialCodes": set(d.get("materialCodes") or codes),
            "referenceOrder": str(d.get("referenceSapOrder") or ""),
            "referenceValue": value,
            "batchCount": batch_count,
            "unitProfileCost": unit_profile_cost,
        })
    return profiles


def find_profile(profiles, line, subset, matched_codes):
    for p in profiles:
        if p["subset"] != subset or line not in p["lines"] or p["unitProfileCost"] <= 0:
            continue
        if p["materialCodes"] and not p["materialCodes"].issubset(set(matched_codes)):
            continue
        return p
    return None


def calculate(history_docs, materials, profiles, mode, request_id):
    candidates = 0
    matched_records = 0
    priced_records = 0
    pending_price_records = 0
    updated = 0
    total_estimated = 0.0
    by_type = Counter()
    by_line = Counter()
    by_subset = Counter()
    by_month_cost = defaultdict(float)
    no_match = Counter()
    samples = []
    timestamp = now_iso()

    for doc in history_docs:
        data = decode_fields(doc)
        typ = normalize_type(data.get("type"))
        if typ not in VALID_TYPES:
            continue
        line = str(data.get("line") or "").strip()
        subset_raw = str(data.get("subset") or "").strip()
        subset = normalize_subset(subset_raw)
        if line not in VALID_LINES or not subset or subset in {"SAP", "SONDA", "-"}:
            continue
        candidates += 1
        by_type[typ] += 1
        by_line[line] += 1
        by_subset[subset_raw or subset] += 1

        matched = [m for m in materials if line in m["lines"] and subset in m["subsets"]]
        if not matched:
            no_match[f"L{line}:{subset_raw or subset}"] += 1
            continue
        matched_records += 1
        codes = [m["code"] for m in matched]
        priced = [m for m in matched if m["unitCost"] > 0]
        profile = find_profile(profiles, line, subset, codes)

        cost = 0.0
        basis = "pending_unit_cost"
        confidence = "pending"
        priced_codes = []
        note = "Materiais correlacionados pelo subconjunto; valores unitários ainda incompletos."

        if profile:
            cost = float(profile["unitProfileCost"])
            basis = "retroactive_profile_order_batch"
            confidence = "estimated"
            priced_codes = list(codes)
            note = f"Estimativa retroativa: R$ {profile['referenceValue']:.2f} da ordem {profile['referenceOrder']} dividido por lote uniforme de {profile['batchCount']} intervenções."
        elif priced:
            cost = sum(float(m["unitCost"]) for m in priced)
            priced_codes = [m["code"] for m in priced]
            basis = "retroactive_current_unit_cost_1_each"
            confidence = "estimated" if len(priced) == len(matched) else "partial"
            note = "Estimativa retroativa pelos valores unitários atualmente cadastrados, considerando 1 unidade de cada material com preço conhecido."

        if cost > 0:
            priced_records += 1
            total_estimated += cost
            month = str(data.get("timestamp") or data.get("createdAt") or "")[:7]
            if len(month) == 7:
                by_month_cost[f"{month}|L{line}"] += cost
        else:
            pending_price_records += 1

        path = doc_path_from_name(doc.get("name", ""))
        fields = dict(doc.get("fields", {}))
        fields.update({
            "linkedMaterialCodes": strings(codes),
            "costedMaterialCodes": strings(priced_codes),
            "materialCostEstimated": dv(round(cost, 2)),
            "materialCostCurrency": sv("BRL"),
            "materialCostStatus": sv("estimated" if cost > 0 and confidence == "estimated" else ("partial" if cost > 0 else "pending_unit_cost")),
            "materialCostBasis": sv(basis),
            "materialCostConfidence": sv(confidence),
            "materialCostIsActual": bv(False),
            "materialCostMatchedCount": iv(len(matched)),
            "materialCostPricedCount": iv(len(priced_codes)),
            "materialCostReferenceAt": sv(timestamp),
            "materialCostNote": sv(note),
            "costBackfillRequestId": sv(request_id),
            "costBackfillVersion": iv(1),
        })

        if mode == "apply":
            patch_full_doc(path, fields)
            # Releitura do próprio documento para confirmar vínculo/custo.
            check = requests.get(f"{API}/{path}", params={"key": FIREBASE_KEY}, timeout=45)
            check.raise_for_status()
            verified = decode_fields(check.json())
            if verified.get("costBackfillRequestId") != request_id or list(verified.get("linkedMaterialCodes") or []) != codes:
                raise RuntimeError(f"releitura não confirmou backfill em {path}")
            updated += 1

        if len(samples) < 12:
            samples.append({
                "path": path,
                "line": line,
                "valve": str(data.get("valve") or ""),
                "type": typ,
                "subset": subset_raw,
                "date": str(data.get("timestamp") or data.get("createdAt") or ""),
                "materials": codes,
                "estimatedCost": round(cost, 2),
                "status": "estimated" if cost > 0 else "pending_unit_cost",
                "basis": basis,
            })

    return {
        "historyTotal": len(history_docs),
        "maintenanceCandidates": candidates,
        "matchedRecords": matched_records,
        "pricedRecords": priced_records,
        "pendingPriceRecords": pending_price_records,
        "updatedRecords": updated,
        "estimatedCostTotal": round(total_estimated, 2),
        "byType": dict(by_type),
        "byLine": dict(by_line),
        "topSubsets": by_subset.most_common(20),
        "noMaterialMatch": no_match.most_common(20),
        "monthlyEstimatedCost": {k: round(v, 2) for k, v in sorted(by_month_cost.items())},
        "samples": samples,
    }


def main():
    cfg_path = sys.argv[1] if len(sys.argv) > 1 else "history_cost_backfill.json"
    status_path = sys.argv[2] if len(sys.argv) > 2 else "history_cost_backfill_status.json"
    cfg = json.loads(Path(cfg_path).read_text(encoding="utf-8"))
    if not cfg.get("enabled", False):
        print("Backfill de custos desativado.")
        return
    mode = str(cfg.get("mode", "dry_run")).strip().lower()
    if mode not in {"dry_run", "apply"}:
        raise ValueError("mode deve ser dry_run ou apply")
    request_id = str(cfg.get("requestId", "")).strip()
    requested_at = str(cfg.get("requestedAt", "")).strip()
    if not request_id:
        raise ValueError("requestId obrigatório")

    materials = material_index(get_collection("materials"))
    profiles = profile_index(get_collection("maintenance_material_profiles"))
    history = get_all_history()
    result = calculate(history, materials, profiles, mode, request_id)
    payload = {
        "status": "verified",
        "requestId": request_id,
        "requestedAt": requested_at,
        "operation": "history_material_cost_backfill",
        "mode": mode,
        "materialsLoaded": len(materials),
        "profilesLoaded": len(profiles),
        **result,
        "stockChanged": False,
        "actualCostChanged": False,
        "verifiedAt": now_iso(),
        "message": "Histórico correlacionado com o catálogo. Custos gravados são estimativas retroativas; estoque e custo SAP real não foram alterados."
    }
    Path(status_path).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
