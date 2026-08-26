#!/usr/bin/env python3
"""Import the current JSON catalogs into the persistent canonical SQLite catalog.

The import is idempotent. It upserts known values, keeps metric/price history, and
stores each normalized input row as a source observation so a future publisher
can be rebuilt without depending on the original JSON files.
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
    file_sha256,
    initialize,
    json_text,
    replace_ranked_memberships,
    payload_sha256,
    utc_now,
)

DEFAULT_DB = Path("data/catalog/catalog.sqlite")
DEFAULT_CATALOG = Path("data/catalog/steamspy_top_2000.json")
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


def first_text(*values: Any) -> str | None:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return None


def source_time(game: dict[str, Any], service: str, fallback: str) -> str:
    times = [
        str(source.get("retrievedAt"))
        for source in game.get("sources", [])
        if isinstance(source, dict) and source.get("service") == service and source.get("retrievedAt")
    ]
    return max(times, default=fallback)


def valid_difficulty(game: dict[str, Any]) -> bool:
    difficulty = game.get("difficulty")
    if not isinstance(difficulty, dict):
        return False
    score = difficulty.get("score")
    return (
        isinstance(score, (int, float))
        and not isinstance(score, bool)
        and 0 <= float(score) <= 100
        and difficulty.get("level") in {"beginner", "easy", "normal", "hard", "hell"}
    )


def upsert_app(connection: Any, game: dict[str, Any], published: dict[str, Any], imported_at: str) -> None:
    appid = int(game["appId"])
    release_date = first_text(game.get("releaseDate"), published.get("releaseDate"))
    canonical_name = first_text(game.get("name"), published.get("name"), f"App {appid}")
    is_searchable = bool(published)
    is_playable = is_searchable and valid_difficulty(published)
    connection.execute(
        """
        INSERT INTO apps(
            appid, canonical_name, app_type, release_date, pics_change_number,
            search_eligible, playable_eligible, excluded, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(appid) DO UPDATE SET
            canonical_name = COALESCE(NULLIF(excluded.canonical_name, ''), apps.canonical_name),
            app_type = COALESCE(excluded.app_type, apps.app_type),
            release_date = COALESCE(excluded.release_date, apps.release_date),
            pics_change_number = COALESCE(excluded.pics_change_number, apps.pics_change_number),
            search_eligible = excluded.search_eligible,
            playable_eligible = excluded.playable_eligible,
            excluded = excluded.excluded,
            updated_at = excluded.updated_at
        """,
        (
            appid,
            canonical_name,
            first_text(game.get("type")),
            release_date,
            game.get("picsChangeNumber"),
            int(is_searchable),
            int(is_playable),
            0,
            imported_at,
            imported_at,
        ),
    )


def replace_names(connection: Any, game: dict[str, Any], imported_at: str) -> None:
    appid = int(game["appId"])
    steamspy_time = source_time(game, "steamspy", imported_at)
    storefront_time = source_time(game, "storefront", imported_at)
    names = [("en", "", first_text(game.get("name")), "steamspy", steamspy_time)]
    for locale, name in game.get("localizedNames", {}).items():
        locale_name = first_text(name)
        if locale_name:
            names.append((str(locale), "cn" if locale == "zh" else "", locale_name, "storefront", storefront_time))
    for locale, country, name, source, retrieved_at in names:
        if not name:
            continue
        connection.execute(
            """
            INSERT INTO app_names(appid, locale, country, name, source, retrieved_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(appid, locale, country, source) DO UPDATE SET
                name = excluded.name,
                retrieved_at = COALESCE(excluded.retrieved_at, app_names.retrieved_at)
            """,
            (appid, locale, country, name, source, retrieved_at),
        )


def replace_companies(connection: Any, game: dict[str, Any], imported_at: str) -> None:
    appid = int(game["appId"])
    retrieved_at = source_time(game, "steamspy", imported_at)
    source = str(game.get("fieldSources", {}).get("developers") or "steamspy")
    for role, field in (("developer", "developers"), ("publisher", "publishers")):
        names = split_company_names(game.get(field, []))
        if not names:
            continue
        connection.execute("DELETE FROM app_companies WHERE appid = ? AND role = ?", (appid, role))
        for position, name in enumerate(names):
            connection.execute(
                "INSERT INTO app_companies(appid, role, position, name, source, retrieved_at) VALUES (?, ?, ?, ?, ?, ?)",
                (appid, role, position, name, source, retrieved_at),
            )


def replace_tags(connection: Any, game: dict[str, Any], imported_at: str) -> None:
    appid = int(game["appId"])
    source = str(game.get("fieldSources", {}).get("tags") or "pics")
    retrieved_at = source_time(game, "pics", imported_at)
    tags = [tag for tag in game.get("tags", []) if isinstance(tag, dict) and first_text(tag.get("name"))]
    if not tags:
        return
    connection.execute("DELETE FROM app_tags WHERE appid = ? AND source = ?", (appid, source))
    for position, tag in enumerate(tags):
        connection.execute(
            "INSERT INTO app_tags(appid, source, position, tag_id, name, retrieved_at) VALUES (?, ?, ?, ?, ?, ?)",
            (appid, source, position, tag.get("id"), first_text(tag.get("name")), retrieved_at),
        )


def insert_prices(connection: Any, game: dict[str, Any], playable: dict[str, Any], imported_at: str) -> None:
    appid = int(game["appId"])
    for country, price in game.get("regionalPrices", {}).items():
        if not isinstance(price, dict):
            continue
        retrieved_at = first_text(price.get("retrievedAt"), source_time(game, "storefront", imported_at)) or imported_at
        connection.execute(
            """
            INSERT OR IGNORE INTO app_prices(
                appid, country, currency, status, regular_cents, current_cents,
                discount_percent, source, retrieved_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'storefront', ?)
            """,
            (
                appid,
                str(country).lower(),
                first_text(price.get("currency")),
                first_text(price.get("status")) or "unknown",
                price.get("regularCents"),
                None,
                None,
                retrieved_at,
            ),
        )

    us_price = playable.get("price", {}).get("us", {}) if playable else {}
    regular = us_price.get("regular") if isinstance(us_price, dict) else None
    if isinstance(regular, (int, float)):
        connection.execute(
            """
            INSERT OR IGNORE INTO app_prices(
                appid, country, currency, status, regular_cents, current_cents,
                discount_percent, source, retrieved_at
            ) VALUES (?, 'us', ?, 'available', ?, NULL, NULL, 'steamspy', ?)
            """,
            (appid, first_text(us_price.get("currency")) or "USD", round(float(regular) * 100), source_time(game, "steamspy", imported_at)),
        )


def replace_media(connection: Any, game: dict[str, Any], playable: dict[str, Any], imported_at: str) -> None:
    appid = int(game["appId"])
    retrieved_at = source_time(game, "storefront", imported_at)
    header = first_text(playable.get("header_image"))
    if header:
        connection.execute(
            """
            INSERT INTO app_media(appid, kind, position, url, source, retrieved_at)
            VALUES (?, 'header', 0, ?, 'storefront', ?)
            ON CONFLICT(appid, kind, position) DO UPDATE SET
                url = excluded.url, source = excluded.source,
                retrieved_at = COALESCE(excluded.retrieved_at, app_media.retrieved_at)
            """,
            (appid, header, retrieved_at),
        )

    catalog_screenshots = game.get("screenshots", []) if isinstance(game.get("screenshots"), list) else []
    normalized_urls = list(dict.fromkeys(
        str(item.get("path") or "").strip()
        for item in catalog_screenshots
        if isinstance(item, dict) and str(item.get("path") or "").strip()
    ))
    if not normalized_urls:
        hints = playable.get("hints", {}) if isinstance(playable.get("hints"), dict) else {}
        screenshot_urls = hints.get("screenshotUrls", [])
        if isinstance(screenshot_urls, list):
            normalized_urls = list(dict.fromkeys(
                str(url).strip() for url in screenshot_urls if str(url or "").strip()
            ))
    connection.execute("DELETE FROM app_media WHERE appid = ? AND kind = 'screenshot'", (appid,))
    for position, url in enumerate(normalized_urls):
        connection.execute(
            """
            INSERT INTO app_media(appid, kind, position, url, source, retrieved_at)
            VALUES (?, 'screenshot', ?, ?, 'storefront', ?)
            """,
            (appid, position, url, retrieved_at),
        )


def insert_metrics(connection: Any, game: dict[str, Any], imported_at: str) -> None:
    appid = int(game["appId"])
    metric = game.get("metrics", {})
    observed_at = source_time(game, "steamspy", imported_at)
    connection.execute(
        """
        INSERT OR REPLACE INTO app_metrics(
            appid, source, observed_at, ccu, peak_yesterday, peak_7d, peak_7d_samples,
            owners_min, owners_max, positive, negative, reviews_total,
            average_forever_minutes, average_two_weeks_minutes,
            median_forever_minutes, median_two_weeks_minutes, raw_json
        ) VALUES (?, 'steamspy', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            appid,
            observed_at,
            metric.get("ccu"),
            metric.get("peakYesterday"),
            metric.get("peak7d"),
            metric.get("peak7dSamples"),
            metric.get("ownersMin"),
            metric.get("ownersMax"),
            metric.get("positive"),
            metric.get("negative"),
            metric.get("reviewsTotal"),
            metric.get("averageForeverMinutes"),
            metric.get("averageTwoWeeksMinutes"),
            metric.get("medianForeverMinutes"),
            metric.get("medianTwoWeeksMinutes"),
            json_text(metric),
        ),
    )


def replace_reviews(connection: Any, game: dict[str, Any], imported_at: str) -> None:
    """Replace the bounded helpful-review snapshot for each requested language."""
    appid = int(game["appId"])
    reviews = game.get("reviews", {})
    if not isinstance(reviews, dict):
        return
    for language in ("english", "schinese"):
        items = reviews.get(language)
        if not isinstance(items, list):
            continue
        valid = [item for item in items if isinstance(item, dict) and first_text(item.get("text"), item.get("review"))]
        if not valid:
            continue
        connection.execute("DELETE FROM app_reviews WHERE appid = ? AND language = ?", (appid, language))
        seen_hashes: set[str] = set()
        position = 0
        for item in valid:
            text = first_text(item.get("text"), item.get("review")) or ""
            review_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
            # Steam can return duplicate review bodies (especially localized
            # snapshots). The database deliberately enforces one body per app
            # and language, so skip duplicates while retaining up to one hundred rows.
            if review_hash in seen_hashes:
                continue
            seen_hashes.add(review_hash)
            position += 1
            if position > 100:
                break
            review_id = first_text(item.get("reviewId"), item.get("recommendationid"), f"{appid}:{language}:{position}") or f"{appid}:{language}:{position}"
            connection.execute(
                """
                INSERT INTO app_reviews(
                    appid, language, position, review_id, review_text, voted_up,
                    votes_up, votes_funny, weighted_vote_score, timestamp_created,
                    timestamp_updated, source, retrieved_at, review_hash
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    appid, language, position, review_id, text,
                    None if item.get("votedUp") is None and item.get("voted_up") is None else int(bool(item.get("votedUp", item.get("voted_up")))),
                    item.get("votesUp", item.get("votes_up")),
                    item.get("votesFunny", item.get("votes_funny")),
                    item.get("weightedVoteScore", item.get("weighted_vote_score")),
                    item.get("timestampCreated", item.get("timestamp_created")),
                    item.get("timestampUpdated", item.get("timestamp_updated")),
                    first_text(item.get("source"), "steamreviews") or "steamreviews",
                    first_text(item.get("retrievedAt"), source_time(game, "steamreviews", imported_at)) or imported_at,
                    review_hash,
                ),
            )


def insert_provenance(connection: Any, game: dict[str, Any], imported_at: str) -> None:
    appid = int(game["appId"])
    for field, source in game.get("fieldSources", {}).items():
        service = str(source).split(":", 1)[0]
        connection.execute(
            """
            INSERT INTO field_provenance(appid, field_name, source, retrieved_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(appid, field_name) DO UPDATE SET
                source = excluded.source,
                retrieved_at = COALESCE(excluded.retrieved_at, field_provenance.retrieved_at)
            """,
            (appid, str(field), str(source), source_time(game, service, imported_at)),
        )


def insert_observations(connection: Any, game: dict[str, Any], batch_id: int, catalog_path: Path, imported_at: str) -> None:
    appid = int(game["appId"])
    connection.execute(
        """
        INSERT OR IGNORE INTO source_observations(
            appid, batch_id, service, endpoint, retrieved_at, change_number,
            raw_path, payload_sha256, payload_json
        ) VALUES (?, ?, 'catalog-import', ?, ?, ?, ?, ?, ?)
        """,
        (
            appid,
            batch_id,
            str(catalog_path),
            imported_at,
            game.get("picsChangeNumber"),
            str(catalog_path),
            payload_sha256(game),
            # The normalized catalog file is already retained and hashed as a
            # source batch. Repeating the full game JSON once per AppID made
            # every import add hundreds of megabytes without adding evidence.
            None,
        ),
    )
    for source in game.get("sources", []):
        if not isinstance(source, dict):
            continue
        service = first_text(source.get("service"))
        endpoint = first_text(source.get("endpoint"))
        retrieved_at = first_text(source.get("retrievedAt"))
        if not service or not endpoint or not retrieved_at:
            continue
        connection.execute(
            """
            INSERT OR IGNORE INTO source_observations(
                appid, service, endpoint, retrieved_at, change_number, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (appid, service, endpoint, retrieved_at, game.get("picsChangeNumber") if service == "pics" else None, None),
        )


def upsert_job(connection: Any, appid: int, service: str, locale: str, country: str, complete: bool, change_number: Any, imported_at: str) -> None:
    connection.execute(
        """
        INSERT INTO enrichment_jobs(
            appid, service, locale, country, status, source_change_number, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(appid, service, locale, country) DO UPDATE SET
            status = CASE WHEN enrichment_jobs.status = 'running' THEN enrichment_jobs.status ELSE excluded.status END,
            source_change_number = COALESCE(excluded.source_change_number, enrichment_jobs.source_change_number),
            updated_at = excluded.updated_at
        """,
        (appid, service, locale, country, "complete" if complete else "pending", change_number, imported_at),
    )


def create_batch(connection: Any, path: Path, service: str, endpoint: str, retrieved_at: str, count: int) -> int:
    digest = file_sha256(path)
    connection.execute(
        """
        INSERT OR IGNORE INTO source_batches(
            service, endpoint, retrieved_at, raw_path, payload_sha256, item_count, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (service, endpoint, retrieved_at, str(path), digest, count, json_text({"kind": "normalized-import"})),
    )
    row = connection.execute(
        "SELECT id FROM source_batches WHERE service = ? AND endpoint = ? AND retrieved_at = ? AND payload_sha256 = ?",
        (service, endpoint, retrieved_at, digest),
    ).fetchone()
    return int(row["id"])


def import_catalog(database: Path, catalog_path: Path, playable_path: Path, active_limit: int = 6000) -> dict[str, int]:
    catalog_payload = load_json(catalog_path)
    playable_payload = load_json(playable_path)
    catalog_rows = rows(catalog_payload)
    published = by_appid(playable_payload)
    searchable_appids = set(published)
    playable_appids = {
        appid for appid, game in published.items()
        if valid_difficulty(game)
    }
    imported_at = utc_now()
    generated_at = first_text(catalog_payload.get("generatedAt") if isinstance(catalog_payload, dict) else None, imported_at) or imported_at

    connection = connect(database)
    try:
        initialize(connection)
        with connection:
            batch_id = create_batch(connection, catalog_path, "catalog-import", str(catalog_path), generated_at, len(catalog_rows))
            create_batch(connection, playable_path, "catalog-import", str(playable_path), generated_at, len(published))
            # The normalized import is a snapshot, not a new upstream
            # observation on every rerun or staging path. Keep exactly one
            # current set; upstream SteamSpy/PICS/Storefront observations remain
            # independent and historical.
            connection.execute(
                "DELETE FROM source_observations WHERE service = 'catalog-import'",
            )

            for game in catalog_rows:
                appid = int(game["appId"])
                published_game = published.get(appid, {})
                upsert_app(connection, game, published_game, imported_at)
                replace_names(connection, game, imported_at)
                replace_companies(connection, game, imported_at)
                replace_tags(connection, game, imported_at)
                replace_reviews(connection, game, imported_at)
                insert_prices(connection, game, published_game, imported_at)
                replace_media(connection, game, published_game, imported_at)
                insert_metrics(connection, game, imported_at)
                insert_provenance(connection, game, imported_at)
                insert_observations(connection, game, batch_id, catalog_path, generated_at)

                state = connection.execute(
                    """
                    SELECT
                        app_type IS NOT NULL AND pics_change_number IS NOT NULL
                          AND EXISTS(SELECT 1 FROM app_tags WHERE app_tags.appid = apps.appid) AS pics_complete,
                        release_date IS NOT NULL AND release_date <> ''
                          AND EXISTS(SELECT 1 FROM app_media WHERE app_media.appid = apps.appid AND kind = 'screenshot') AS english_complete,
                        EXISTS(SELECT 1 FROM app_names WHERE app_names.appid = apps.appid AND locale = 'zh')
                          AND EXISTS(SELECT 1 FROM latest_app_prices WHERE latest_app_prices.appid = apps.appid AND country = 'cn') AS chinese_complete
                    FROM apps WHERE appid = ?
                    """,
                    (appid,),
                ).fetchone()
                upsert_job(connection, appid, "pics", "", "", bool(state["pics_complete"]), game.get("picsChangeNumber"), imported_at)
                # Detailed enrichment is intentionally wider than the playable
                # answer pool. Persist job completion for every discovered row
                # so reserve metadata is reusable and is not fetched again on
                # every weekly run.
                upsert_job(connection, appid, "storefront", "english", "us", bool(state["english_complete"]), None, imported_at)
                upsert_job(connection, appid, "storefront", "schinese", "cn", bool(state["chinese_complete"]), None, imported_at)
                reviews = game.get("reviews", {})
                for language in ("english", "schinese"):
                    fetch_limits = game.get("reviewFetchLimits", {}) if isinstance(game.get("reviewFetchLimits"), dict) else {}
                    review_complete = int(fetch_limits.get(language, 0) or 0) >= 100
                    upsert_job(connection, appid, "reviews", language, "", review_complete, None, imported_at)

            for catalog_name in ("discovery", "labeling"):
                connection.execute("DELETE FROM catalog_memberships WHERE catalog = ?", (catalog_name,))
            for game in catalog_rows:
                connection.execute(
                    "INSERT INTO catalog_memberships(catalog, appid, included_at, reason) VALUES ('discovery', ?, ?, 'SteamSpy candidate')",
                    (int(game["appId"]), imported_at),
                )
            replace_ranked_memberships(
                connection,
                catalog_rows,
                searchable_appids,
                playable_appids,
                active_limit,
                imported_at,
            )
            for key, value in {
                "schema_version": "2",
                "active_limit": str(active_limit),
                "last_import_at": imported_at,
                "source_catalog": str(catalog_path),
                "source_catalog_generated_at": generated_at,
            }.items():
                connection.execute(
                    """
                    INSERT INTO catalog_meta(key, value, updated_at) VALUES (?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                    """,
                    (key, value, imported_at),
                )

        return database_stats(connection)
    finally:
        connection.close()


def scalar(connection: Any, sql: str) -> int:
    return int(connection.execute(sql).fetchone()[0])


def database_stats(connection: Any) -> dict[str, int]:
    return {
        "apps": scalar(connection, "SELECT COUNT(*) FROM apps"),
        "active": scalar(connection, "SELECT COUNT(*) FROM catalog_memberships WHERE catalog = 'active'"),
        "reserve": scalar(connection, "SELECT COUNT(*) FROM catalog_memberships WHERE catalog = 'reserve'"),
        "editorial_excluded": scalar(connection, "SELECT COUNT(*) FROM catalog_exclusions"),
        "searchable": scalar(connection, "SELECT COUNT(*) FROM catalog_memberships WHERE catalog = 'search'"),
        "playable": scalar(connection, "SELECT COUNT(*) FROM catalog_memberships WHERE catalog = 'playable'"),
        "reviews": scalar(connection, "SELECT COUNT(DISTINCT appid) FROM app_reviews"),
        "release_dates": scalar(connection, "SELECT COUNT(*) FROM apps WHERE release_date IS NOT NULL AND release_date <> ''"),
        "chinese_names": scalar(connection, "SELECT COUNT(DISTINCT appid) FROM app_names WHERE locale = 'zh'"),
        "screenshots": scalar(connection, "SELECT COUNT(DISTINCT appid) FROM app_media WHERE kind = 'screenshot'"),
        "cn_prices": scalar(connection, "SELECT COUNT(DISTINCT appid) FROM latest_app_prices WHERE country = 'cn' AND status IN ('available', 'free')"),
        "pending_jobs": scalar(connection, "SELECT COUNT(*) FROM enrichment_jobs WHERE status = 'pending'"),
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
