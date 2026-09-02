#!/usr/bin/env python3
"""Validate a staged catalog before it replaces the production snapshot.

The converged catalog has one business table: ``games``. Rank-window
membership is materialized by the publisher and is not stored as side tables.
"""

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
            and type(difficulty.get("score")) is int
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
    require(
        all(len(row.get("tags", {}).get("userTags", [])) <= 20 for row in search_rows),
        "user tags contain at most 20 entries",
    )
    require(
        all(row.get("difficulty") is None or valid_difficulty(row) for row in search_rows),
        "search catalog contains only absent or authoritative 0-100 difficulty values",
    )

    connection = sqlite3.connect(args.db)
    connection.row_factory = sqlite3.Row
    try:
        tables = {
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        require("games" in tables, "SQLite contains the converged games table")
        require("apps" not in tables, "SQLite no longer creates the legacy apps table")
        require("catalog_memberships" not in tables, "SQLite no longer creates catalog membership tables")
        require("catalog_exclusions" not in tables, "SQLite no longer creates catalog exclusion tables")
        require("difficulty_ai_candidates" not in tables, "SQLite no longer creates AI difficulty tables")
        require("difficulty_overrides" not in tables, "SQLite no longer creates difficulty side tables")
        require("app_prices" not in tables, "SQLite no longer creates normalized price tables")

        games = connection.execute("SELECT * FROM games").fetchall()
        apps = len(games)
        db_ids = {int(row["appid"]) for row in games}
        excluded_ids = {
            int(row["appid"])
            for row in games
            if row["pool_status"] == "excluded"
        }
        ranked_ids = [
            appid for appid in ids
            if appid in db_ids and appid not in excluded_ids
        ]
        expected_search_ids = set(ranked_ids[:max(0, args.active_limit)])
        require(
            len(expected_search_ids) >= args.min_active,
            f"active catalog has {len(expected_search_ids)} games",
        )
        require(
            expected_search_ids == search_ids,
            "published search catalog matches the rank window and exclusions",
        )
        require(answer_ids <= search_ids, "answer pool is a subset of the search catalog")
        require(apps >= len(catalog_rows), f"SQLite contains {apps} game records")
        require(
            len(search_ids) <= args.active_limit,
            f"published search catalog has {len(search_ids)} games",
        )
        require(
            not any(row.get("catalogStatus") == "excluded" for row in search_rows),
            "excluded games are not published",
        )

        game_columns = {
            str(row["name"])
            for row in connection.execute("PRAGMA table_info(games)")
        }
        require(
            "price_us_current_cents" not in game_columns
            and "price_cn_current_cents" not in game_columns,
            "SQLite contains no current or discount price fields",
        )
        require(
            all(
                row["difficulty_score"] is None
                or (
                    type(row["difficulty_score"]) is int
                    and 0 <= row["difficulty_score"] <= 100
                )
                for row in games
            ),
            "SQLite difficulty scores are absent or integer values from 0 to 100",
        )
        require(
            all(
                row["difficulty_tier"] is None
                or row["difficulty_tier"] in {"beginner", "easy", "normal", "hard", "hell"}
                for row in games
            ),
            "SQLite difficulty tiers are valid",
        )
        json_columns = (
            "developers_json", "publishers_json", "tags_json",
            "screenshot_urls_json", "reviews_en_json", "reviews_zh_json",
            "steam_metrics_json", "raw_sources_json", "source_meta_json",
            "enrichment_status_json", "field_provenance_json",
        )
        valid_json = True
        for row in games:
            for column in json_columns:
                try:
                    json.loads(row[column] or "{}")
                except (TypeError, json.JSONDecodeError):
                    valid_json = False
        require(valid_json, "SQLite JSON columns contain valid JSON")
    finally:
        connection.close()

    if failures:
        for failure in failures:
            print(f"FAIL {failure}")
        raise SystemExit(1)
    print(
        f"READY catalog={len(catalog_rows)} active={len(search_ids)} "
        f"search={len(search_rows)} playable={len(answer_ids)}"
    )


if __name__ == "__main__":
    main()
