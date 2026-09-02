#!/usr/bin/env python3
"""Import the normalized catalog into the one-row-per-game SQLite database.

The JSON files are pipeline checkpoints. ``games`` is the runtime catalog
authority: every AppID is stored once, source payloads are retained as JSON,
and editorial difficulty/status fields survive weekly metadata refreshes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from scripts.catalog.common import split_company_names
from scripts.catalog.database import (
    connect,
    initialize,
    is_non_game_type,
    json_load,
    json_text,
    utc_now,
)

DEFAULT_DB = Path("data/catalog/catalog.sqlite")
DEFAULT_CATALOG = Path("data/catalog/steamspy_candidates.json")
DEFAULT_PLAYABLE = Path("public/games_demo.json")


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def rows(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict) and isinstance(payload.get("games"), list):
        return [row for row in payload["games"] if isinstance(row, dict)]
    if isinstance(payload, dict):
        return [row for row in payload.values() if isinstance(row, dict)]
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    raise ValueError("Unsupported catalog shape")


def by_appid(payload: Any) -> dict[int, dict[str, Any]]:
    return {int(row["appId"]): row for row in rows(payload) if row.get("appId")}


def text(value: Any) -> str | None:
    result = str(value or "").strip()
    return result or None


def unique_strings(values: Any) -> list[str]:
    values = values if isinstance(values, list) else [values]
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        item = text(value)
        if item and item.casefold() not in seen:
            seen.add(item.casefold())
            result.append(item)
    return result


def normalize_reviews(game: dict[str, Any], language: str) -> list[dict[str, Any]]:
    reviews = game.get("reviews", {})
    values = reviews.get(language, []) if isinstance(reviews, dict) else []
    return [item for item in values if isinstance(item, dict) and text(item.get("text") or item.get("review"))]


def latest_price(game: dict[str, Any], country: str) -> dict[str, Any]:
    prices = game.get("regionalPrices", {})
    value = prices.get(country, {}) if isinstance(prices, dict) else {}
    return value if isinstance(value, dict) else {}


def merge_json_object(existing: Any, incoming: Any) -> Any:
    """Merge a new source snapshot without throwing away older raw fields."""
    if not isinstance(incoming, dict) or not incoming:
        return existing if isinstance(existing, dict) else {}
    if not isinstance(existing, dict):
        return incoming
    merged = dict(existing)
    for key, value in incoming.items():
        if value not in (None, "", [], {}):
            merged[key] = value
    return merged


def normalized_screenshots(game: dict[str, Any], published: dict[str, Any]) -> list[str]:
    values = game.get("screenshots", [])
    if not isinstance(values, list):
        values = published.get("hints", {}).get("screenshotUrls", [])
    result: list[str] = []
    for item in values if isinstance(values, list) else []:
        url = text(item.get("path") if isinstance(item, dict) else item)
        if url and url not in result:
            result.append(url)
    return result


def source_meta(game: dict[str, Any]) -> dict[str, Any]:
    return {
        "sources": game.get("sources", []),
        "fieldSources": game.get("fieldSources", {}),
        "retrievedAt": utc_now(),
    }


def status_for_existing(existing: Any) -> tuple[str, str | None]:
    if not existing:
        return "eligible", None
    return str(existing["pool_status"] or "eligible"), text(existing["status_reason"])


def initial_pool_status(game: dict[str, Any]) -> tuple[str, str | None]:
    if is_non_game_type(game.get("type")):
        return "excluded", "non_game_type"
    return "eligible", None


def upsert_game(connection: Any, game: dict[str, Any], published: dict[str, Any], imported_at: str) -> None:
    appid = int(game["appId"])
    existing = connection.execute(
        """
        SELECT pool_status, status_reason, difficulty_score, difficulty_tier,
               difficulty_manual_score, difficulty_locked, difficulty_source,
               raw_steamspy_json, raw_storefront_json, raw_reviews_json,
               raw_sources_json
        FROM games WHERE appid = ?
        """, (appid,)
    ).fetchone()
    pool_status, status_reason = status_for_existing(existing)
    if not existing:
        pool_status, status_reason = initial_pool_status(game)
    if pool_status not in {"eligible", "search_only", "excluded"}:
        pool_status = "eligible"

    metrics = game.get("metrics", {})
    metrics = metrics if isinstance(metrics, dict) else {}
    steamspy_raw = dict(game)
    storefront_raw = {
        key: game.get(key)
        for key in (
            "name", "localizedNames", "type", "releaseDate", "developers",
            "publishers", "regionalPrices", "headerImage", "screenshots",
        )
        if key in game
    }
    reviews_en = normalize_reviews(game, "english")
    reviews_zh = normalize_reviews(game, "schinese")
    us = latest_price(game, "us")
    cn = latest_price(game, "cn")
    developers = split_company_names(game.get("developers", []))
    publishers = split_company_names(game.get("publishers", []))
    tags = [tag for tag in game.get("tags", []) if isinstance(tag, dict)] if isinstance(game.get("tags"), list) else []
    name_zh = text((game.get("localizedNames") or {}).get("zh")) if isinstance(game.get("localizedNames"), dict) else None
    if not name_zh and isinstance(published.get("localizedNames"), dict):
        name_zh = text(published["localizedNames"].get("zh"))
    existing_difficulty = {
        "score": existing["difficulty_score"] if existing else None,
        "tier": existing["difficulty_tier"] if existing else None,
        "manual": existing["difficulty_manual_score"] if existing else None,
        "locked": int(existing["difficulty_locked"]) if existing else 0,
        "source": existing["difficulty_source"] if existing else None,
    }
    columns = [
        "appid", "name_en", "name_zh", "app_type", "release_date", "pics_change_number",
        "cover_url", "developers_json", "publishers_json", "tags_json",
        "screenshot_urls_json", "reviews_en_json", "reviews_zh_json",
        "price_us_currency", "price_us_status", "price_us_regular_cents",
        "price_cn_currency", "price_cn_status", "price_cn_regular_cents",
        "steam_ccu", "steam_peak_yesterday", "steam_peak_7d", "steam_peak_7d_samples",
        "steam_owners_min", "steam_owners_max", "steam_positive", "steam_negative",
        "steam_reviews_total", "steam_average_forever_minutes",
        "steam_average_two_weeks_minutes", "steam_median_forever_minutes",
        "steam_median_two_weeks_minutes", "steam_metrics_json",
        "pool_status", "status_reason", "difficulty_score", "difficulty_tier",
        "difficulty_manual_score", "difficulty_locked", "difficulty_source",
        "raw_steamspy_json", "raw_pics_json", "raw_storefront_json", "raw_reviews_json",
        "raw_sources_json", "source_meta_json", "enrichment_status_json",
        "field_provenance_json", "created_at", "updated_at",
    ]
    values = (
        appid, text(game.get("name")) or f"App {appid}", name_zh, text(game.get("type")),
        text(game.get("releaseDate")), game.get("picsChangeNumber"),
        text(game.get("headerImage")) or text(published.get("header_image")),
        json_text(developers), json_text(publishers), json_text(tags),
        json_text(normalized_screenshots(game, published)), json_text(reviews_en),
        json_text(reviews_zh),
        text(us.get("currency")), text(us.get("status")), us.get("regularCents"),
        text(cn.get("currency")), text(cn.get("status")), cn.get("regularCents"),
        metrics.get("ccu"), metrics.get("peakYesterday"), metrics.get("peak7d"),
        metrics.get("peak7dSamples"), metrics.get("ownersMin"), metrics.get("ownersMax"),
        metrics.get("positive"), metrics.get("negative"), metrics.get("reviewsTotal"),
        metrics.get("averageForeverMinutes"), metrics.get("averageTwoWeeksMinutes"),
        metrics.get("medianForeverMinutes"), metrics.get("medianTwoWeeksMinutes"),
        json_text(metrics), pool_status, status_reason,
        existing_difficulty["score"], existing_difficulty["tier"],
        existing_difficulty["manual"], existing_difficulty["locked"],
        existing_difficulty["source"], json_text(merge_json_object(
            json_load(existing["raw_steamspy_json"], {}) if existing else {},
            steamspy_raw,
        )),
        json_text(game.get("rawPics")) if game.get("rawPics") else None,
        json_text(merge_json_object(
            json_load(existing["raw_storefront_json"], {}) if existing else {},
            storefront_raw,
        )),
        json_text(merge_json_object(
            json_load(existing["raw_reviews_json"], {}) if existing else {},
            {"english": reviews_en, "schinese": reviews_zh}
            if reviews_en or reviews_zh else {},
        )),
        json_text(merge_json_object(
            json_load(existing["raw_sources_json"], {}) if existing else {},
            game.get("rawSources", {}),
        )),
        json_text(source_meta(game)),
        json_text({
            "storefront": "success" if any(key in game for key in ("type", "regionalPrices")) else None,
            "reviews": game.get("reviewFetchLimits", {}),
        }),
        json_text(game.get("fieldSources", {})),
        imported_at, imported_at,
    )
    connection.execute(
        f"""
        INSERT INTO games(
            {", ".join(columns)}
        ) VALUES ({", ".join("?" for _ in columns)})
        ON CONFLICT(appid) DO UPDATE SET
            name_en=COALESCE(NULLIF(excluded.name_en, ''), games.name_en),
            name_zh=COALESCE(NULLIF(excluded.name_zh, ''), games.name_zh),
            app_type=COALESCE(excluded.app_type, games.app_type),
            release_date=COALESCE(excluded.release_date, games.release_date),
            pics_change_number=COALESCE(excluded.pics_change_number, games.pics_change_number),
            cover_url=COALESCE(NULLIF(excluded.cover_url, ''), games.cover_url),
            developers_json=CASE WHEN excluded.developers_json <> '[]' THEN excluded.developers_json ELSE games.developers_json END,
            publishers_json=CASE WHEN excluded.publishers_json <> '[]' THEN excluded.publishers_json ELSE games.publishers_json END,
            tags_json=CASE WHEN excluded.tags_json <> '[]' THEN excluded.tags_json ELSE games.tags_json END,
            screenshot_urls_json=CASE WHEN excluded.screenshot_urls_json <> '[]' THEN excluded.screenshot_urls_json ELSE games.screenshot_urls_json END,
            reviews_en_json=CASE WHEN excluded.reviews_en_json <> '[]' THEN excluded.reviews_en_json ELSE games.reviews_en_json END,
            reviews_zh_json=CASE WHEN excluded.reviews_zh_json <> '[]' THEN excluded.reviews_zh_json ELSE games.reviews_zh_json END,
            price_us_currency=COALESCE(excluded.price_us_currency, games.price_us_currency),
            price_us_status=COALESCE(excluded.price_us_status, games.price_us_status),
            price_us_regular_cents=COALESCE(excluded.price_us_regular_cents, games.price_us_regular_cents),
            price_cn_currency=COALESCE(excluded.price_cn_currency, games.price_cn_currency),
            price_cn_status=COALESCE(excluded.price_cn_status, games.price_cn_status),
            price_cn_regular_cents=COALESCE(excluded.price_cn_regular_cents, games.price_cn_regular_cents),
            steam_ccu=COALESCE(excluded.steam_ccu, games.steam_ccu),
            steam_peak_yesterday=COALESCE(excluded.steam_peak_yesterday, games.steam_peak_yesterday),
            steam_peak_7d=COALESCE(excluded.steam_peak_7d, games.steam_peak_7d),
            steam_peak_7d_samples=COALESCE(excluded.steam_peak_7d_samples, games.steam_peak_7d_samples),
            steam_owners_min=COALESCE(excluded.steam_owners_min, games.steam_owners_min),
            steam_owners_max=COALESCE(excluded.steam_owners_max, games.steam_owners_max),
            steam_positive=COALESCE(excluded.steam_positive, games.steam_positive),
            steam_negative=COALESCE(excluded.steam_negative, games.steam_negative),
            steam_reviews_total=COALESCE(excluded.steam_reviews_total, games.steam_reviews_total),
            steam_average_forever_minutes=COALESCE(excluded.steam_average_forever_minutes, games.steam_average_forever_minutes),
            steam_average_two_weeks_minutes=COALESCE(excluded.steam_average_two_weeks_minutes, games.steam_average_two_weeks_minutes),
            steam_median_forever_minutes=COALESCE(excluded.steam_median_forever_minutes, games.steam_median_forever_minutes),
            steam_median_two_weeks_minutes=COALESCE(excluded.steam_median_two_weeks_minutes, games.steam_median_two_weeks_minutes),
            steam_metrics_json=CASE WHEN excluded.steam_metrics_json <> '{{}}' THEN excluded.steam_metrics_json ELSE games.steam_metrics_json END,
            raw_steamspy_json=COALESCE(excluded.raw_steamspy_json, games.raw_steamspy_json),
            raw_pics_json=COALESCE(excluded.raw_pics_json, games.raw_pics_json),
            raw_storefront_json=CASE WHEN excluded.raw_storefront_json <> '{{}}' THEN excluded.raw_storefront_json ELSE games.raw_storefront_json END,
            raw_reviews_json=CASE WHEN excluded.raw_reviews_json <> '{{}}' THEN excluded.raw_reviews_json ELSE games.raw_reviews_json END,
            raw_sources_json=CASE WHEN excluded.raw_sources_json <> '{{}}' THEN excluded.raw_sources_json ELSE games.raw_sources_json END,
            source_meta_json=CASE WHEN excluded.source_meta_json <> '{{}}' THEN excluded.source_meta_json ELSE games.source_meta_json END,
            enrichment_status_json=CASE WHEN excluded.enrichment_status_json <> '{{}}' THEN excluded.enrichment_status_json ELSE games.enrichment_status_json END,
            field_provenance_json=CASE WHEN excluded.field_provenance_json <> '{{}}' THEN excluded.field_provenance_json ELSE games.field_provenance_json END,
            updated_at=excluded.updated_at
        """,
        values,
    )


def import_catalog(database: Path, catalog_path: Path, playable_path: Path, active_limit: int = 6000) -> dict[str, int]:
    catalog_payload = load_json(catalog_path)
    published = by_appid(load_json(playable_path)) if playable_path.exists() else {}
    catalog_rows = rows(catalog_payload)
    imported_at = utc_now()
    connection = connect(database)
    try:
        initialize(connection)
        with connection:
            for game in catalog_rows:
                upsert_game(connection, game, published.get(int(game["appId"]), {}), imported_at)
            connection.execute(
                "INSERT INTO catalog_meta(key,value,updated_at) VALUES ('active_limit',?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
                (str(active_limit), imported_at),
            )
            connection.execute(
                "INSERT INTO catalog_meta(key,value,updated_at) VALUES ('last_import_at',?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
                (imported_at, imported_at),
            )
        return database_stats(connection, active_limit)
    finally:
        connection.close()


def scalar(connection: Any, sql: str, params: tuple[Any, ...] = ()) -> int:
    return int(connection.execute(sql, params).fetchone()[0])


def database_stats(connection: Any, active_limit: int = 0) -> dict[str, int]:
    non_excluded = "pool_status <> 'excluded'"
    active = scalar(connection, f"SELECT COUNT(*) FROM games WHERE {non_excluded}") if active_limit <= 0 else min(
        active_limit, scalar(connection, f"SELECT COUNT(*) FROM games WHERE {non_excluded}")
    )
    return {
        "games": scalar(connection, "SELECT COUNT(*) FROM games"),
        "active": active,
        "reserve": max(0, scalar(connection, "SELECT COUNT(*) FROM games WHERE pool_status <> 'excluded'") - active),
        "searchable": scalar(connection, "SELECT COUNT(*) FROM games WHERE pool_status IN ('eligible','search_only')"),
        "playable": scalar(connection, "SELECT COUNT(*) FROM games WHERE pool_status = 'eligible' AND difficulty_tier IS NOT NULL"),
        "reviews": scalar(connection, "SELECT COUNT(*) FROM games WHERE reviews_en_json <> '[]' OR reviews_zh_json <> '[]'"),
        "release_dates": scalar(connection, "SELECT COUNT(*) FROM games WHERE release_date IS NOT NULL AND release_date <> ''"),
        "chinese_names": scalar(connection, "SELECT COUNT(*) FROM games WHERE name_zh IS NOT NULL AND name_zh <> ''"),
        "screenshots": scalar(connection, "SELECT COUNT(*) FROM games WHERE screenshot_urls_json <> '[]'"),
        "cn_prices": scalar(connection, "SELECT COUNT(*) FROM games WHERE price_cn_status IN ('available','free')"),
        "pending_jobs": 0,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--playable", type=Path, default=DEFAULT_PLAYABLE)
    parser.add_argument("--active-limit", type=int, default=6000)
    args = parser.parse_args()
    stats = import_catalog(args.db, args.catalog, args.playable, args.active_limit)
    print(f"db={args.db}")
    print(" ".join(f"{key}={value}" for key, value in stats.items()))


if __name__ == "__main__":
    main()
