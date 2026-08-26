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
    except Exception as error:
        raise SystemExit(f"Cannot read staged release: {error}") from error

    catalog_rows = rows(catalog)
    search_rows = rows(playable)
    ids = [int(row["appId"]) for row in catalog_rows if row.get("appId")]
    search_ids = {int(row["appId"]) for row in search_rows if row.get("appId")}

    def valid_difficulty(row) -> bool:
        difficulty = row.get("difficulty")
        return (
            isinstance(difficulty, dict)
            and difficulty.get("level") in {"beginner", "easy", "normal", "hard", "hell"}
            and isinstance(difficulty.get("score"), (int, float))
            and not isinstance(difficulty.get("score"), bool)
            and 0 <= difficulty["score"] <= 100
        )

    answer_ids = {
        int(row["appId"])
        for row in search_rows
        if row.get("appId") and valid_difficulty(row)
    }
    require(bool(catalog_rows), "catalog is not empty")
    require(len(ids) == len(set(ids)), "catalog AppIDs are unique")
    require(len(search_ids) == len(search_rows), "search catalog AppIDs are unique")
    require(all(len(row.get("tags", {}).get("userTags", [])) <= 20 for row in search_rows), "user tags contain at most 20 entries")
    require(
        all(
            row.get("difficulty") is None or valid_difficulty(row)
            for row in search_rows
        ),
        "search catalog contains only absent or authoritative 0-100 difficulty values",
    )

    connection = sqlite3.connect(args.db)
    try:
        apps = connection.execute("SELECT COUNT(*) FROM apps").fetchone()[0]
        active_ids = {
            int(row[0])
            for row in connection.execute("SELECT appid FROM catalog_memberships WHERE catalog='active'")
        }
        db_search_ids = {
            int(row[0])
            for row in connection.execute("SELECT appid FROM catalog_memberships WHERE catalog='search'")
        }
        db_playable_ids = {
            int(row[0])
            for row in connection.execute("SELECT appid FROM catalog_memberships WHERE catalog='playable'")
        }
        excluded_ids = {
            int(row[0])
            for row in connection.execute("SELECT appid FROM catalog_exclusions")
        }
        ranked_eligible_ids = [appid for appid in ids if appid not in excluded_ids]
        expected_active_ids = set(ranked_eligible_ids[:max(0, args.active_limit)])
        current_prices = connection.execute("SELECT COUNT(*) FROM app_prices WHERE current_cents IS NOT NULL OR discount_percent IS NOT NULL").fetchone()[0]
        cached_tag_ids = {int(row[0]) for row in connection.execute("SELECT DISTINCT appid FROM app_tags")}
        catalog_tag_ids = {int(row["appId"]) for row in catalog_rows if int(row.get("appId", 0)) in active_ids and row.get("tags")}
        search_tag_ids = {int(row["appId"]) for row in search_rows if row.get("tags", {}).get("userTags")}
        expected_catalog_tags = cached_tag_ids & active_ids
        expected_search_tags = cached_tag_ids & search_ids
        require(len(active_ids) >= args.min_active, f"active catalog has {len(active_ids)} games")
        require(active_ids == expected_active_ids, "SQLite active membership skips editorial exclusions and preserves the rank window")
        require(not active_ids.intersection(excluded_ids), "editorially excluded games are outside active membership")
        require(search_ids <= active_ids, "search catalog is limited to active games")
        require(answer_ids <= search_ids, "answer pool is a subset of the search catalog")
        require(db_search_ids == search_ids, "SQLite search membership matches the published search catalog")
        require(db_playable_ids == answer_ids, "SQLite playable membership matches scored answer rows")
        require(apps >= len(catalog_rows), f"SQLite contains {apps} app records")
        require(len(active_ids) <= args.active_limit, f"SQLite active membership is {len(active_ids)}")
        require(expected_catalog_tags <= catalog_tag_ids, f"normalized catalog preserves {len(expected_catalog_tags)} cached PICS tag sets")
        require(expected_search_tags <= search_tag_ids, f"search catalog publishes {len(expected_search_tags)} cached PICS tag sets")
        require(current_prices == 0, "SQLite contains no current/discount price fields")
    finally:
        connection.close()

    if failures:
        for failure in failures:
            print(f"FAIL {failure}")
        raise SystemExit(1)
    print(
        f"READY catalog={len(catalog_rows)} active={len(active_ids)} "
        f"search={len(search_rows)} playable={len(answer_ids)}"
    )


if __name__ == "__main__":
    main()
