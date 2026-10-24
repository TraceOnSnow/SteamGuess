#!/usr/bin/env python3
"""Publish the browser catalog from the converged SQLite ``games`` table."""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Any


def parse(value: str | None, fallback: Any) -> Any:
    try:
        return json.loads(value) if value else fallback
    except (TypeError, json.JSONDecodeError):
        return fallback


def publish(catalog_path: Path, db_path: Path, out: Path, active_limit: int, search_limit: int = 2000) -> int:
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    source_games = catalog.get("games", []) if isinstance(catalog, dict) else catalog
    ordered_ids = [int(game["appId"]) for game in source_games if isinstance(game, dict) and game.get("appId")]
    curated = {int(game["appId"]): game for game in source_games} if isinstance(catalog, dict) and catalog.get("collection") == "classics" else {}
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    try:
        selected = []
        for appid in ordered_ids:
            row = db.execute("SELECT * FROM games WHERE appid = ?", (appid,)).fetchone()
            if not row or row["pool_status"] == "excluded":
                continue
            selected.append(row)
            if active_limit > 0 and len(selected) >= active_limit:
                break
        if curated:
            # Search membership is deliberately wider than answer membership.
            # Prefer recovered rows with useful comparison metadata, then use
            # review count as the stable popularity tie-breaker.
            selected_ids = {row["appid"] for row in selected}
            placeholders = ",".join("?" for _ in selected_ids) or "NULL"
            extra = db.execute(f"""
                SELECT * FROM games
                WHERE pool_status <> 'excluded'
                  AND (app_type IS NULL OR LOWER(app_type) IN ('game', 'mod'))
                  AND steam_reviews_total IS NOT NULL
                  AND appid NOT IN ({placeholders})
                ORDER BY (release_date IS NOT NULL AND release_date <> '' AND tags_json <> '[]') DESC,
                         steam_reviews_total DESC, steam_ccu DESC, appid ASC
                LIMIT ?
            """, (*sorted(selected_ids), max(0, search_limit - len(selected)))).fetchall()
            selected.extend(extra)
    finally:
        db.close()

    result: dict[str, dict[str, Any]] = {}
    for row in selected:
        tags = parse(row["tags_json"], [])
        developers = parse(row["developers_json"], [])
        publishers = parse(row["publishers_json"], [])
        screenshots = parse(row["screenshot_urls_json"], [])
        reviews_en = parse(row["reviews_en_json"], [])
        reviews_zh = parse(row["reviews_zh_json"], [])
        fixed = curated.get(row["appid"], {}).get("difficulty")
        score = row["difficulty_score"] if row["pool_status"] == "eligible" else None
        game: dict[str, Any] = {
            "appId": int(row["appid"]),
            "name": row["name_en"],
            "localizedNames": {"zh": row["name_zh"]} if row["name_zh"] else {},
            "type": row["app_type"],
            "releaseDate": row["release_date"] or "",
            "developers": developers,
            "publishers": publishers,
            "edition": "classics" if curated else None,
            "collection": "classics" if row["appid"] in curated else None,
            "aliases": curated.get(row["appid"], {}).get("aliases", []),
            "metrics": {
                "ccu": row["steam_ccu"] or 0,
                "peakYesterday": row["steam_peak_yesterday"],
                "peak7d": row["steam_peak_7d"],
                "peak7dSamples": row["steam_peak_7d_samples"],
                "ownersMin": row["steam_owners_min"],
                "ownersMax": row["steam_owners_max"],
                "positive": row["steam_positive"] or 0,
                "negative": row["steam_negative"] or 0,
                "reviewsTotal": row["steam_reviews_total"] or 0,
            },
            "price": {
                "us": {
                    "currency": row["price_us_currency"] or "USD",
                    "regular": (row["price_us_regular_cents"] or 0) / 100,
                },
                "cn": (
                    {
                        "currency": row["price_cn_currency"] or "CNY",
                        "regular": (row["price_cn_regular_cents"] or 0) / 100,
                    }
                    if row["price_cn_status"] in {"available", "free"}
                    else {}
                ),
            },
            "reviews": {"total": row["steam_reviews_total"] or 0, "positive": row["steam_positive"] or 0, "negative": row["steam_negative"] or 0},
            "popularity": {"ccu": row["steam_ccu"] or 0, **{key: row[column] for key, column in (("peakYesterday", "steam_peak_yesterday"), ("peak7d", "steam_peak_7d"), ("peak7dSamples", "steam_peak_7d_samples")) if row[column] is not None}},
            "catalogStatus": row["pool_status"],
            "tags": {
                "userTags": [str(item.get("name") or "") if isinstance(item, dict) else str(item) for item in tags if item][:20],
                "developers": developers,
                "publishers": publishers,
            },
            "hints": {
                "screenshotUrls": screenshots[:6] if row["appid"] in curated else screenshots,
                **({} if curated else {"reviewTexts": [
                    str(item.get("text") or item.get("review") or "")
                    for item in (reviews_zh or reviews_en)
                    if isinstance(item, dict) and str(item.get("text") or item.get("review") or "").strip()
                ]}),
            },
            "header_image": row["cover_url"] or "",
        }
        if score is not None and row["difficulty_tier"] in {"beginner", "easy", "normal", "hard", "hell"}:
            game["difficulty"] = {
                "score": int(score),
                "level": row["difficulty_tier"],
                "source": row["difficulty_source"] or "manual",
                "locked": bool(row["difficulty_locked"]),
            }
            game["difficultyScore"] = int(score)
            game["difficultyLevel"] = row["difficulty_tier"]
        if fixed and row["pool_status"] == "eligible":
            game["difficulty"] = fixed
            game["difficultyScore"] = fixed["score"]
            game["difficultyLevel"] = fixed["level"]
            game["familiarity"] = curated[row["appid"]].get("familiarity")
        if curated and row["appid"] not in curated:
            # Database scores from other experiments never turn search-only
            # rows into answers. No answer hints or eligibility badge in UI.
            game["catalogStatus"] = "search_only"
            for key in ("difficulty", "difficultyScore", "difficultyLevel", "familiarity",
                        "hints", "metrics", "collection", "aliases", "developers", "publishers"):
                game.pop(key, None)
        result[str(row["appid"])] = game

    out.parent.mkdir(parents=True, exist_ok=True)
    temporary = out.with_name(out.name + ".tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(out)
    print(f"selected={len(selected)} published={len(result)} out={out}")
    return len(result)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", default="data/curated/classics.json")
    parser.add_argument("--db", default="data/catalog/catalog.sqlite")
    parser.add_argument("--playable", default="public/games_demo.json", help="Compatibility alias; not read")
    parser.add_argument("--out", default="public/games_demo.json")
    parser.add_argument("--active-limit", type=int, default=0)
    parser.add_argument("--search-limit", type=int, default=2000)
    args = parser.parse_args()
    publish(Path(args.catalog), Path(args.db), Path(args.out), args.active_limit, args.search_limit)


if __name__ == "__main__":
    main()
