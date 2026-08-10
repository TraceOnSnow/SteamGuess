#!/usr/bin/env python3
"""Validate a staged catalog before it replaces the production snapshot."""
from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path


def rows(payload):
    if isinstance(payload, dict) and isinstance(payload.get("games"), list):
        return [row for row in payload["games"] if isinstance(row, dict)]
    if isinstance(payload, dict):
        return [row for row in payload.values() if isinstance(row, dict)]
    return [row for row in payload if isinstance(row, dict)] if isinstance(payload, list) else []


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--playable", type=Path, required=True)
    parser.add_argument("--labeling", type=Path, required=True)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--active-limit", type=int, default=6000)
    parser.add_argument("--min-active", type=int, default=1)
    args = parser.parse_args()

    failures: list[str] = []
    def require(condition: bool, message: str) -> None:
        if not condition:
            failures.append(message)
        else:
            print(f"PASS {message}")

    try:
        catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
        playable = json.loads(args.playable.read_text(encoding="utf-8"))
        labeling = json.loads(args.labeling.read_text(encoding="utf-8"))
    except Exception as error:
        raise SystemExit(f"Cannot read staged release: {error}") from error

    catalog_rows = rows(catalog)
    playable_rows = rows(playable)
    labeling_rows = rows(labeling)
    ids = [int(row["appId"]) for row in catalog_rows if row.get("appId")]
    active = catalog_rows[: max(0, args.active_limit)]
    active_ids = {int(row["appId"]) for row in active if row.get("appId")}
    playable_ids = {int(row["appId"]) for row in playable_rows if row.get("appId")}
    require(bool(catalog_rows), "catalog is not empty")
    require(len(ids) == len(set(ids)), "catalog AppIDs are unique")
    require(len(active_ids) >= args.min_active, f"active catalog has {len(active_ids)} games")
    require(playable_ids <= active_ids, "playable catalog is limited to active games")
    require(len(labeling_rows) >= len(playable_rows), "labeling catalog covers playable catalog")
    require(all(len(row.get("tags", {}).get("userTags", [])) <= 20 for row in playable_rows), "user tags contain at most 20 entries")

    connection = sqlite3.connect(args.db)
    try:
        apps = connection.execute("SELECT COUNT(*) FROM apps").fetchone()[0]
        active_db = connection.execute("SELECT COUNT(*) FROM catalog_memberships WHERE catalog='active'").fetchone()[0]
        current_prices = connection.execute("SELECT COUNT(*) FROM app_prices WHERE current_cents IS NOT NULL OR discount_percent IS NOT NULL").fetchone()[0]
        cached_tag_ids = {int(row[0]) for row in connection.execute("SELECT DISTINCT appid FROM app_tags")}
        catalog_tag_ids = {int(row["appId"]) for row in active if row.get("tags")}
        playable_tag_ids = {int(row["appId"]) for row in playable_rows if row.get("tags", {}).get("userTags")}
        expected_catalog_tags = cached_tag_ids & active_ids
        expected_playable_tags = cached_tag_ids & playable_ids
        require(apps >= len(catalog_rows), f"SQLite contains {apps} app records")
        require(active_db == len(active_ids), f"SQLite active membership is {active_db}")
        require(expected_catalog_tags <= catalog_tag_ids, f"normalized catalog preserves {len(expected_catalog_tags)} cached PICS tag sets")
        require(expected_playable_tags <= playable_tag_ids, f"playable catalog publishes {len(expected_playable_tags)} cached PICS tag sets")
        require(current_prices == 0, "SQLite contains no current/discount price fields")
    finally:
        connection.close()

    if failures:
        for failure in failures:
            print(f"FAIL {failure}")
        raise SystemExit(1)
    print(f"READY catalog={len(catalog_rows)} active={len(active_ids)} playable={len(playable_rows)}")


if __name__ == "__main__":
    main()
