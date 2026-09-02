#!/usr/bin/env python3
"""Migrate the legacy normalized catalog into the converged ``games`` table.

The migration is deliberately one-way and offline:

* the source database is opened read-only and is never modified;
* the enriched catalog JSON wins when it contains a value;
* normalized legacy tables are used as a fallback;
* SteamSpy/PICS raw payloads are copied into the row-level JSON columns;
* all historical AI, regression, manual-score and feedback data is discarded.

The caller should validate the output and atomically replace the production
database only after this command succeeds.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

from scripts.catalog.database import (
    connect,
    initialize,
    is_non_game_type,
    json_text,
    level_for_score,
    utc_now,
)
from scripts.catalog.common import split_company_names


def rows(connection: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
    return connection.execute(sql, params).fetchall()


def has_table(connection: sqlite3.Connection, name: str) -> bool:
    return connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)
    ).fetchone() is not None


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def catalog_rows(path: Path | None) -> dict[int, dict[str, Any]]:
    if path is None or not path.exists():
        return {}
    payload = load_json(path)
    values = payload.get("games", []) if isinstance(payload, dict) else payload
    if not isinstance(values, list):
        return {}
    return {
        int(item["appId"]): item
        for item in values
        if isinstance(item, dict) and item.get("appId")
    }


def steamspy_raw_map(directory: Path) -> dict[int, Any]:
    """Read the newest raw page for each page number and merge its payload."""
    result: dict[int, Any] = {}
    if not directory.exists():
        return result
    page_files: dict[int, Path] = {}
    for path in directory.glob("page_*.json"):
        try:
            page = int(path.name.split("_", 2)[1])
        except (IndexError, ValueError):
            continue
        previous = page_files.get(page)
        if previous is None or path.stat().st_mtime > previous.stat().st_mtime:
            page_files[page] = path
    for path in sorted(page_files.values(), key=lambda item: item.stat().st_mtime):
        try:
            payload = load_json(path).get("payload", {})
            if isinstance(payload, dict):
                result.update({int(appid): value for appid, value in payload.items()})
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            continue
    return result


def pics_raw_map(path: Path | None) -> dict[int, Any]:
    if path is None or not path.exists():
        return {}
    payload = load_json(path)
    games = payload.get("games", {}) if isinstance(payload, dict) else {}
    return {
        int(appid): value
        for appid, value in games.items()
        if isinstance(value, dict)
    } if isinstance(games, dict) else {}


def grouped(
    connection: sqlite3.Connection,
    table: str,
    order_by: str = "",
) -> dict[int, list[sqlite3.Row]]:
    if not has_table(connection, table):
        return {}
    result: dict[int, list[sqlite3.Row]] = defaultdict(list)
    query = f"SELECT * FROM {table}"
    if order_by:
        query += f" ORDER BY {order_by}"
    for row in rows(connection, query):
        result[int(row["appid"])].append(row)
    return result


def text(value: Any) -> str | None:
    value = str(value or "").strip()
    return value or None


def unique_strings(values: Iterable[Any]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        item = text(value)
        if item and item.casefold() not in seen:
            seen.add(item.casefold())
            result.append(item)
    return result


def json_or(value: Any, fallback: Any) -> Any:
    if value in (None, ""):
        return fallback
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return fallback
    return value


def latest_by_key(
    grouped_rows: dict[int, list[sqlite3.Row]],
    appid: int,
    key: str,
) -> sqlite3.Row | None:
    values = grouped_rows.get(appid, [])
    return values[-1] if values else None


def old_app_ids(old: sqlite3.Connection) -> set[int]:
    if not has_table(old, "apps"):
        return set()
    return {int(row["appid"]) for row in rows(old, "SELECT appid FROM apps")}


def old_exclusions(old: sqlite3.Connection) -> dict[int, str]:
    if not has_table(old, "catalog_exclusions"):
        return {}
    return {
        int(row["appid"]): str(row["reason"] or "manual_exclusion")
        for row in rows(old, "SELECT appid, reason FROM catalog_exclusions")
    }


def old_game_row(old: sqlite3.Connection, appid: int) -> sqlite3.Row | None:
    if not has_table(old, "apps"):
        return None
    return old.execute("SELECT * FROM apps WHERE appid = ?", (appid,)).fetchone()


def choose_name(
    game: dict[str, Any] | None,
    app: sqlite3.Row | None,
    names: dict[int, list[sqlite3.Row]],
    appid: int,
) -> tuple[str, str | None]:
    game = game or {}
    name_en = text(game.get("name"))
    name_zh = None
    localized = game.get("localizedNames")
    if isinstance(localized, dict):
        name_zh = text(localized.get("zh") or localized.get("schinese"))
    for row in names.get(appid, []):
        locale = str(row["locale"] or "").casefold()
        if locale in {"en", "english"} and not name_en:
            name_en = text(row["name"])
        if locale in {"zh", "schinese"} and not name_zh:
            name_zh = text(row["name"])
    if not name_en and app is not None:
        name_en = text(app["canonical_name"])
    return name_en or f"App {appid}", name_zh


def choose_companies(
    game: dict[str, Any] | None,
    companies: dict[int, list[sqlite3.Row]],
    appid: int,
) -> tuple[list[str], list[str]]:
    game = game or {}
    developers = split_company_names(game.get("developers", []))
    publishers = split_company_names(game.get("publishers", []))
    if not developers:
        developers = split_company_names([
            row["name"] for row in companies.get(appid, [])
            if row["role"] == "developer"
        ])
    if not publishers:
        publishers = split_company_names([
            row["name"] for row in companies.get(appid, [])
            if row["role"] == "publisher"
        ])
    return developers, publishers


def choose_tags(
    game: dict[str, Any] | None,
    tags: dict[int, list[sqlite3.Row]],
    appid: int,
) -> list[dict[str, Any]]:
    game_tags = (game or {}).get("tags")
    if isinstance(game_tags, list) and game_tags:
        return [item for item in game_tags if isinstance(item, dict)]
    return [
        {
            "id": row["tag_id"],
            "rank": int(row["position"]) + 1,
            "name": row["name"],
            "source": row["source"],
        }
        for row in tags.get(appid, [])
        if text(row["name"])
    ]


def choose_screenshots(
    game: dict[str, Any] | None,
    media: dict[int, list[sqlite3.Row]],
    appid: int,
) -> tuple[str | None, list[str]]:
    game = game or {}
    cover = text(game.get("headerImage"))
    screenshots: list[str] = []
    values = game.get("screenshots")
    if isinstance(values, list):
        for item in values:
            value = item.get("path") if isinstance(item, dict) else item
            value = text(value)
            if value and value not in screenshots:
                screenshots.append(value)
    for row in media.get(appid, []):
        value = text(row["url"])
        if row["kind"] in {"header", "capsule"} and not cover:
            cover = value
        if row["kind"] == "screenshot" and value and value not in screenshots:
            screenshots.append(value)
    return cover, screenshots


def choose_reviews(
    game: dict[str, Any] | None,
    reviews: dict[int, list[sqlite3.Row]],
    appid: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    game_reviews = (game or {}).get("reviews")
    if not isinstance(game_reviews, dict):
        game_reviews = {}

    def from_game(language: str) -> list[dict[str, Any]]:
        values = game_reviews.get(language, [])
        return [item for item in values if isinstance(item, dict) and text(item.get("text"))]

    def from_old(language: str) -> list[dict[str, Any]]:
        return [
            {
                "reviewId": row["review_id"],
                "text": row["review_text"],
                "votedUp": row["voted_up"],
                "votesUp": row["votes_up"],
                "votesFunny": row["votes_funny"],
                "weightedVoteScore": row["weighted_vote_score"],
                "timestampCreated": row["timestamp_created"],
                "timestampUpdated": row["timestamp_updated"],
                "source": row["source"],
                "retrievedAt": row["retrieved_at"],
            }
            for row in reviews.get(appid, [])
            if row["language"] == language and text(row["review_text"])
        ]

    english = from_game("english") or from_old("english")
    schinese = from_game("schinese") or from_old("schinese")
    return english, schinese


def choose_price(
    game: dict[str, Any] | None,
    prices: dict[tuple[int, str], sqlite3.Row],
    appid: int,
    country: str,
) -> tuple[str | None, str | None, int | None]:
    regional = (game or {}).get("regionalPrices")
    value = regional.get(country, {}) if isinstance(regional, dict) else {}
    if isinstance(value, dict) and value.get("status"):
        return text(value.get("currency")), text(value.get("status")), value.get("regularCents")
    row = prices.get((appid, country))
    if row is None:
        return None, None, None
    return text(row["currency"]), text(row["status"]), row["regular_cents"]


def choose_metrics(
    game: dict[str, Any] | None,
    metrics: dict[int, sqlite3.Row],
    appid: int,
) -> dict[str, Any]:
    value = (game or {}).get("metrics")
    if isinstance(value, dict) and value:
        return value
    row = metrics.get(appid)
    if row is None:
        return {}
    return {
        "ccu": row["ccu"],
        "peakYesterday": row["peak_yesterday"],
        "peak7d": row["peak_7d"],
        "peak7dSamples": row["peak_7d_samples"],
        "ownersMin": row["owners_min"],
        "ownersMax": row["owners_max"],
        "positive": row["positive"],
        "negative": row["negative"],
        "reviewsTotal": row["reviews_total"],
        "averageForeverMinutes": row["average_forever_minutes"],
        "averageTwoWeeksMinutes": row["average_two_weeks_minutes"],
        "medianForeverMinutes": row["median_forever_minutes"],
        "medianTwoWeeksMinutes": row["median_two_weeks_minutes"],
    }


def raw_observations(old: sqlite3.Connection, appid: int) -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, Any], dict[str, Any]]:
    if not has_table(old, "source_observations"):
        return [], {}, {}, {}
    observations = rows(
        old,
        "SELECT * FROM source_observations WHERE appid = ? ORDER BY retrieved_at ASC, id ASC",
        (appid,),
    )
    source_meta: list[dict[str, Any]] = []
    raw_sources: list[dict[str, Any]] = []
    latest: dict[str, dict[str, Any]] = {}
    for row in observations:
        item = {
            "service": row["service"],
            "endpoint": row["endpoint"],
            "locale": row["locale"],
            "country": row["country"],
            "retrievedAt": row["retrieved_at"],
            "changeNumber": row["change_number"],
            "rawPath": row["raw_path"],
            "payloadSha256": row["payload_sha256"],
        }
        source_meta.append(item)
        payload = json_or(row["payload_json"], None)
        if payload is not None:
            raw_sources.append({**item, "payload": payload})
        service = str(row["service"] or "")
        if payload is not None:
            latest[service] = {"endpoint": row["endpoint"], "retrievedAt": row["retrieved_at"], "payload": payload}
    return source_meta, {"observations": source_meta}, {"observations": raw_sources}, latest


def migrated_game(
    old: sqlite3.Connection,
    new: sqlite3.Connection,
    appid: int,
    game: dict[str, Any] | None,
    raw_steamspy: Any,
    raw_pics: Any,
    names: dict[int, list[sqlite3.Row]],
    companies: dict[int, list[sqlite3.Row]],
    tags: dict[int, list[sqlite3.Row]],
    media: dict[int, list[sqlite3.Row]],
    prices: dict[tuple[int, str], sqlite3.Row],
    metrics: dict[int, sqlite3.Row],
    reviews: dict[int, list[sqlite3.Row]],
    exclusions: dict[int, str],
    provenance: dict[int, list[sqlite3.Row]],
    now: str,
) -> None:
    game = game or {}
    app = old_game_row(old, appid)
    name_en, name_zh = choose_name(game, app, names, appid)
    developers, publishers = choose_companies(game, companies, appid)
    tag_values = choose_tags(game, tags, appid)
    cover, screenshots = choose_screenshots(game, media, appid)
    reviews_en, reviews_zh = choose_reviews(game, reviews, appid)
    metrics_value = choose_metrics(game, metrics, appid)
    us_currency, us_status, us_regular = choose_price(game, prices, appid, "us")
    cn_currency, cn_status, cn_regular = choose_price(game, prices, appid, "cn")
    app_type = text(game.get("type")) or (text(app["app_type"]) if app is not None else None)
    release_date = text(game.get("releaseDate")) or (text(app["release_date"]) if app is not None else None)
    app_pics_change = game.get("picsChangeNumber")
    if app_pics_change is None and app is not None:
        app_pics_change = app["pics_change_number"]

    reason = exclusions.get(appid)
    is_excluded = bool(app is not None and int(app["excluded"] or 0)) or is_non_game_type(app_type)
    if is_excluded:
        pool_status, status_reason = "excluded", reason or ("non_game_type" if is_non_game_type(app_type) else "legacy_exclusion")
    elif reason in {"too_obscure", "beyond_hell", "search_only"}:
        pool_status, status_reason = "search_only", reason
    else:
        pool_status, status_reason = "eligible", None

    source_meta, source_observations, raw_sources, latest = raw_observations(old, appid)
    if not raw_pics and "pics" in latest:
        raw_pics = latest["pics"].get("payload")
    raw_storefront = latest.get("storefront", {})
    raw_reviews = {
        "english": reviews_en,
        "schinese": reviews_zh,
    }
    if "reviews" in latest:
        raw_reviews = latest["reviews"].get("payload") or raw_reviews
    field_sources = {
        str(row["field_name"]): {
            "source": row["source"],
            "retrievedAt": row["retrieved_at"],
        }
        for row in provenance.get(appid, [])
    }
    if isinstance(game.get("fieldSources"), dict):
        field_sources.update({
            str(key): {"source": value}
            for key, value in game["fieldSources"].items()
        })
    raw_storefront = raw_storefront or {
        "name": game.get("name"),
        "localizedName": name_zh,
        "type": app_type,
        "releaseDate": release_date,
        "developers": developers,
        "publishers": publishers,
        "headerImage": cover,
        "screenshots": game.get("screenshots", screenshots),
        "regionalPrices": game.get("regionalPrices", {}),
    }
    columns = [
        "appid", "igdb_game_id", "name_en", "name_zh", "app_type", "release_date",
        "pics_change_number", "cover_url", "developers_json", "publishers_json",
        "tags_json", "screenshot_urls_json", "reviews_en_json", "reviews_zh_json",
        "price_us_currency", "price_us_status", "price_us_regular_cents",
        "price_cn_currency", "price_cn_status", "price_cn_regular_cents",
        "steam_ccu", "steam_peak_yesterday", "steam_peak_7d", "steam_peak_7d_samples",
        "steam_owners_min", "steam_owners_max", "steam_positive", "steam_negative",
        "steam_reviews_total", "steam_average_forever_minutes",
        "steam_average_two_weeks_minutes", "steam_median_forever_minutes",
        "steam_median_two_weeks_minutes", "steam_metrics_json", "heat_score", "heat_rank",
        "pool_status", "status_reason", "difficulty_score", "difficulty_tier",
        "difficulty_manual_score", "difficulty_locked", "difficulty_source",
        "player_feedback_count", "player_feedback_mean", "player_feedback_stddev",
        "player_feedback_updated_at", "raw_steamspy_json", "raw_pics_json",
        "raw_storefront_json", "raw_reviews_json", "raw_sources_json",
        "source_meta_json", "enrichment_status_json", "field_provenance_json",
        "created_at", "updated_at",
    ]
    values = [
        appid, game.get("igdbGameId"), name_en, name_zh, app_type, release_date,
        app_pics_change, cover, json_text(developers), json_text(publishers),
        json_text(tag_values), json_text(screenshots), json_text(reviews_en),
        json_text(reviews_zh), us_currency, us_status, us_regular, cn_currency,
        cn_status, cn_regular, metrics_value.get("ccu"), metrics_value.get("peakYesterday"),
        metrics_value.get("peak7d"), metrics_value.get("peak7dSamples"),
        metrics_value.get("ownersMin"), metrics_value.get("ownersMax"),
        metrics_value.get("positive"), metrics_value.get("negative"),
        metrics_value.get("reviewsTotal"), metrics_value.get("averageForeverMinutes"),
        metrics_value.get("averageTwoWeeksMinutes"), metrics_value.get("medianForeverMinutes"),
        metrics_value.get("medianTwoWeeksMinutes"), json_text(metrics_value),
        game.get("heatScore"), game.get("heatRank"), pool_status, status_reason,
        None, None, None, 0, None, 0, None, None, None, json_text(raw_steamspy),
        json_text(raw_pics), json_text(raw_storefront), json_text(raw_reviews),
        json_text(raw_sources), json_text({
            "catalog": game.get("sources", []),
            "observations": source_meta,
        }), json_text({
            "screenshots": len(screenshots),
            "reviews": {"english": len(reviews_en), "schinese": len(reviews_zh)},
        }), json_text(field_sources), now, now,
    ]
    placeholders = ", ".join("?" for _ in columns)
    new.execute(
        f"INSERT INTO games ({', '.join(columns)}) VALUES ({placeholders})",
        values,
    )


def migrate(
    source: Path,
    output: Path,
    catalog_path: Path | None,
    raw_steamspy_dir: Path,
    raw_pics_path: Path | None,
) -> dict[str, int]:
    if output.exists():
        raise SystemExit(f"Output already exists: {output}; choose another path or remove it")
    if not source.exists():
        raise SystemExit(f"Source database does not exist: {source}")
    old = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    old.row_factory = sqlite3.Row
    new = connect(output)
    initialize(new)
    candidate_games = catalog_rows(catalog_path)
    steamspy = steamspy_raw_map(raw_steamspy_dir)
    pics = pics_raw_map(raw_pics_path)
    names = grouped(old, "app_names", "retrieved_at ASC")
    companies = grouped(old, "app_companies", "position ASC, retrieved_at ASC")
    tags = grouped(old, "app_tags", "source ASC, position ASC, retrieved_at ASC")
    media = grouped(old, "app_media", "kind ASC, position ASC, retrieved_at ASC")
    reviews = grouped(old, "app_reviews", "language ASC, position ASC, retrieved_at ASC")
    metrics_rows = grouped(old, "app_metrics", "observed_at ASC")
    metrics = {appid: values[-1] for appid, values in metrics_rows.items()}
    prices_rows = grouped(old, "app_prices", "retrieved_at ASC")
    prices = {
        (appid, str(value["country"]).casefold()): value
        for appid, values in prices_rows.items()
        for value in values
    }
    exclusions = old_exclusions(old)
    provenance = grouped(old, "field_provenance", "retrieved_at ASC")
    appids = sorted(old_app_ids(old) | set(candidate_games) | set(steamspy) | set(pics))
    now = utc_now()
    with new:
        for appid in appids:
            migrated_game(
                old, new, appid, candidate_games.get(appid), steamspy.get(appid),
                pics.get(appid), names, companies, tags, media, prices, metrics,
                reviews, exclusions, provenance, now,
            )
        new.execute(
            "INSERT INTO catalog_meta(key, value, updated_at) VALUES ('last_migration_at', ?, ?)",
            (now, now),
        )
        new.execute(
            "INSERT INTO catalog_meta(key, value, updated_at) VALUES ('legacy_difficulty_discarded', 'true', ?)",
            (now,),
        )
    old.close()
    new.close()
    check = connect(output)
    try:
        game_count = int(check.execute("SELECT COUNT(*) FROM games").fetchone()[0])
        excluded_count = int(check.execute("SELECT COUNT(*) FROM games WHERE pool_status='excluded'").fetchone()[0])
        raw_count = int(check.execute(
            "SELECT COUNT(*) FROM games WHERE raw_steamspy_json IS NOT NULL OR raw_pics_json IS NOT NULL"
        ).fetchone()[0])
    finally:
        check.close()
    return {
        "games": game_count,
        "excluded": excluded_count,
        "rawGames": raw_count,
        "candidateGames": len(candidate_games),
        "steamspyRawRows": len(steamspy),
        "picsRawRows": len(pics),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("data/catalog/catalog.sqlite"))
    parser.add_argument("--catalog", type=Path, default=Path("data/catalog/steamspy_candidates.json"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--raw-steamspy-dir", type=Path, default=Path("data/raw/steamspy"))
    parser.add_argument("--raw-pics", type=Path)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    print(json.dumps(migrate(
        args.source, args.output, args.catalog, args.raw_steamspy_dir, args.raw_pics,
    ), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
