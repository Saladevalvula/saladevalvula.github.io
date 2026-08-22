# -*- coding: utf-8 -*-
"""Fallback manual Notion -> Firebase V2.

O polling automático permanece desativado. Este script apenas busca as páginas
mais recentemente editadas e delega cada uma ao registrador idempotente V2.
"""
import os
import sys
import requests

from register_notion_page import register_page, notion_headers

NOTION_DATABASE_ID = os.environ.get("NOTION_DATABASE_ID", "82e7f0430a3f46098853a32d96f7a7d2")


def fetch_recent_page_ids(limit):
    # O endpoint databases/query continua compatível com o banco original.
    url = f"https://api.notion.com/v1/databases/{NOTION_DATABASE_ID}/query"
    payload = {"page_size": min(max(limit, 1), 100), "sorts": [{"timestamp": "last_edited_time", "direction": "descending"}]}
    r = requests.post(url, headers=notion_headers(), json=payload, timeout=30)
    r.raise_for_status()
    return [p["id"] for p in r.json().get("results", [])]


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 50
    ok = skipped = failed = 0
    for page_id in fetch_recent_page_ids(limit):
        try:
            register_page(page_id); ok += 1
        except ValueError as exc:
            print(f"SKIP {page_id}: {exc}"); skipped += 1
        except Exception as exc:
            print(f"ERRO {page_id}: {exc}"); failed += 1
    print(f"Resumo V2: ok={ok} skipped={skipped} failed={failed}")
    if failed:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
