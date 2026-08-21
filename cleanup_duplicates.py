# -*- coding: utf-8 -*-
import json
import os
import time
from collections import Counter, OrderedDict

import requests

FIREBASE_KEY = os.environ["FIREBASE_KEY"]
FIREBASE_PROJ = os.environ.get("FIREBASE_PROJ", "sala-valvulas-ow-163b3")
APPLY = os.environ.get("APPLY", "0") == "1"
LINES = ["512", "513", "514"]

ROOT = (
    f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJ}"
    f"/databases/(default)/documents"
)
COMMIT_URL = (
    f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJ}"
    f"/databases/(default)/documents:commit?key={FIREBASE_KEY}"
)


def list_valve_docs(line_id):
    url = f"{ROOT}/lines/{line_id}/valves"
    token = None
    while True:
        params = {"key": FIREBASE_KEY, "pageSize": 100}
        if token:
            params["pageToken"] = token
        resp = requests.get(url, params=params, timeout=60)
        resp.raise_for_status()
        body = resp.json()
        for doc in body.get("documents", []):
            yield doc
        token = body.get("nextPageToken")
        if not token:
            break


def get_doc(doc_name):
    relative = doc_name.split("/documents/", 1)[1]
    resp = requests.get(f"{ROOT}/{relative}", params={"key": FIREBASE_KEY}, timeout=60)
    resp.raise_for_status()
    return resp.json()


def history_values(doc):
    return (
        doc.get("fields", {})
        .get("historico", {})
        .get("arrayValue", {})
        .get("values", [])
    )


def map_fields(value):
    return value.get("mapValue", {}).get("fields", {})


def string_field(value, name):
    return map_fields(value).get(name, {}).get("stringValue", "")


def duplicate_key(value):
    """
    Considera duplicadas apenas anotações com todos os dados iguais,
    desconsiderando os identificadores técnicos id/notionPageId.
    """
    fields = map_fields(value)
    comparable = {
        key: val
        for key, val in fields.items()
        if key not in {"id", "notionPageId"}
    }
    return json.dumps(comparable, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def dedupe_history(values):
    groups = OrderedDict()
    for value in values:
        groups.setdefault(duplicate_key(value), []).append(value)

    cleaned = []
    removed = 0
    for group in groups.values():
        if len(group) == 1:
            cleaned.append(group[0])
            continue

        # Se uma das cópias já tem rastreabilidade do Notion, preserva essa.
        preferred = next(
            (item for item in group if string_field(item, "notionPageId")),
            group[0],
        )
        cleaned.append(preferred)
        removed += len(group) - 1

    return cleaned, removed


def type_counts(values):
    return Counter(string_field(v, "type") or "(sem tipo)" for v in values)


def commit_history(doc, cleaned):
    write = {
        "update": {
            "name": doc["name"],
            "fields": {
                "historico": {"arrayValue": {"values": cleaned}}
            },
        },
        "updateMask": {"fieldPaths": ["historico"]},
        "currentDocument": {"updateTime": doc["updateTime"]},
    }
    return requests.post(COMMIT_URL, json={"writes": [write]}, timeout=60)


def apply_document(initial_doc):
    doc = initial_doc
    for attempt in range(1, 4):
        values = history_values(doc)
        cleaned, removed = dedupe_history(values)
        if removed == 0:
            return 0, True

        resp = commit_history(doc, cleaned)
        if resp.status_code in (200, 201):
            return removed, True

        if resp.status_code in (409, 412) and attempt < 3:
            time.sleep(0.5 * attempt)
            doc = get_doc(doc["name"])
            continue

        print(
            f"ERRO {doc['name']} -> {resp.status_code}: "
            f"{resp.text[:300].replace(chr(10), ' ')}"
        )
        return 0, False

    return 0, False


def main():
    mode = "APLICAR" if APPLY else "AUDITORIA"
    print(f"=== LIMPEZA DE DUPLICATAS: {mode} ===")
    print("Regra: registros idênticos, ignorando apenas id/notionPageId, viram uma única cópia.")

    docs_total = 0
    docs_with_duplicates = 0
    before_total = 0
    after_total = 0
    candidates_removed = 0
    applied_removed = 0
    failures = 0
    before_types = Counter()
    after_types = Counter()

    for line_id in LINES:
        line_before = line_after = line_removed = line_docs = 0
        for doc in list_valve_docs(line_id):
            docs_total += 1
            values = history_values(doc)
            cleaned, removed = dedupe_history(values)

            before_total += len(values)
            after_total += len(cleaned)
            candidates_removed += removed
            before_types.update(type_counts(values))
            after_types.update(type_counts(cleaned))

            line_before += len(values)
            line_after += len(cleaned)
            line_removed += removed

            if removed:
                docs_with_duplicates += 1
                line_docs += 1
                relative = doc["name"].split("/documents/", 1)[1]
                print(f"DUP {relative}: {len(values)} -> {len(cleaned)} (remove {removed})")

                if APPLY:
                    removed_now, ok = apply_document(doc)
                    applied_removed += removed_now
                    if not ok:
                        failures += 1

        print(
            f"L{line_id}: {line_before} registros -> {line_after}; "
            f"duplicatas={line_removed}; docs afetados={line_docs}"
        )

    print("\n=== RESUMO ===")
    print(f"Documentos lidos: {docs_total}")
    print(f"Documentos com duplicatas: {docs_with_duplicates}")
    print(f"Históricos antes: {before_total}")
    print(f"Históricos após dedupe calculado: {after_total}")
    print(f"Duplicatas identificadas: {candidates_removed}")
    print(f"Tipos antes: {dict(before_types)}")
    print(f"Tipos depois: {dict(after_types)}")

    if APPLY:
        print(f"Duplicatas removidas no Firebase: {applied_removed}")
        print(f"Falhas de atualização: {failures}")
        if failures:
            raise SystemExit(1)
    else:
        print("AUDITORIA APENAS: nenhum dado foi apagado.")


if __name__ == "__main__":
    main()
