#!/usr/bin/env python3
"""Import the current JSON catalogs into the persistent canonical SQLite catalog.

The import is idempotent. It upserts known values, keeps metric/price history, and
stores each normalized input row as a source observation so a future publisher
can be rebuilt without depending on the original JSON files.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from scripts.catalog.common import split_company_names
from scripts.catalog.database import connect, file_sha256, initialize, json_text, payload_sha256, utc_now

DEFAULT_DB = Path("data/catalog/catalog.sqlite")
DEFAULT_CATALOG = Path("data/catalog/steamspy_top_2000.json")
DEFAULT_PLAYABLE = Path("public/games_demo.json")
DEFAULT_LABELING = Path("public/labeling_catalog.json")


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


def upsert_app(connection: Any, game: dict[str, Any], playable: dict[str, Any], imported_at: str) -> None:
    appid = int(game["appId"])
    difficulty = game.get("difficulty", {})
    release_date = first_text(game.get("releaseDate"), playable.get("releaseDate"))
    canonical_name = first_text(game.get("name"), playable.get("name"), f"App {appid}")
    is_playable = bool(playable)
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
            int(is_playable),
            int(is_playable),
            int(bool(difficulty.get("excluded"))),
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
                price.get("currentCents"),
                price.get("discountPercent"),
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
    media = [
        ("header", first_text(playable.get("header_image")), "storefront"),
        ("screenshot", first_text(playable.get("hints", {}).get("screenshotUrl")), "storefront"),
    ]
    for kind, url, source in media:
        if not url:
            continue
        connection.execute(
            """
            INSERT INTO app_media(appid, kind, position, url, source, retrieved_at)
            VALUES (?, ?, 0, ?, ?, ?)
            ON CONFLICT(appid, kind, position) DO UPDATE SET
                url = excluded.url, source = excluded.source,
                retrieved_at = COALESCE(excluded.retrieved_at, app_media.retrieved_at)
            """,
            (appid, kind, url, source, source_time(game, "storefront", imported_at)),
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


def upsert_scores(connection: Any, game: dict[str, Any], imported_at: str) -> None:
    recognition = game.get("recognition", {})
    difficulty = game.get("difficulty", {})
    connection.execute(
        """
        INSERT INTO app_scores(
            appid, recognition_score, recognition_features_json, difficulty_score,
            difficulty_level, difficulty_source, manual_level, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(appid) DO UPDATE SET
            recognition_score = COALESCE(excluded.recognition_score, app_scores.recognition_score),
            recognition_features_json = COALESCE(excluded.recognition_features_json, app_scores.recognition_features_json),
            difficulty_score = COALESCE(excluded.difficulty_score, app_scores.difficulty_score),
            difficulty_level = COALESCE(excluded.difficulty_level, app_scores.difficulty_level),
            difficulty_source = COALESCE(excluded.difficulty_source, app_scores.difficulty_source),
            manual_level = COALESCE(excluded.manual_level, app_scores.manual_level),
            updated_at = excluded.updated_at
        """,
        (
            int(game["appId"]),
            recognition.get("score"),
            json_text(recognition.get("features", {})),
            difficulty.get("score"),
            difficulty.get("level"),
            difficulty.get("source"),
            difficulty.get("manualLevel"),
            imported_at,
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
            json_text(game),
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


def import_catalog(database: Path, catalog_path: Path, playable_path: Path, labeling_path: Path) -> dict[str, int]:
    catalog_payload = load_json(catalog_path)
    playable_payload = load_json(playable_path)
    labeling_payload = load_json(labeling_path)
    catalog_rows = rows(catalog_payload)
    playable = by_appid(playable_payload)
    labeling = by_appid(labeling_payload)
    imported_at = utc_now()
    generated_at = first_text(catalog_payload.get("generatedAt") if isinstance(catalog_payload, dict) else None, imported_at) or imported_at

    connection = connect(database)
    try:
        initialize(connection)
        with connection:
            batch_id = create_batch(connection, catalog_path, "catalog-import", str(catalog_path), generated_at, len(catalog_rows))
            create_batch(connection, playable_path, "catalog-import", str(playable_path), generated_at, len(playable))
            labeling_generated = first_text(labeling_payload.get("generatedAt") if isinstance(labeling_payload, dict) else None, generated_at) or generated_at
            create_batch(connection, labeling_path, "catalog-import", str(labeling_path), labeling_generated, len(labeling))
            # The normalized import is a snapshot, not a new upstream observation on every rerun.
            connection.execute(
                "DELETE FROM source_observations WHERE service = 'catalog-import' AND endpoint = ?",
                (str(catalog_path),),
            )

            for game in catalog_rows:
                appid = int(game["appId"])
                playable_game = playable.get(appid, {})
                upsert_app(connection, game, playable_game, imported_at)
                replace_names(connection, game, imported_at)
                replace_companies(connection, game, imported_at)
                replace_tags(connection, game, imported_at)
                insert_prices(connection, game, playable_game, imported_at)
                replace_media(connection, game, playable_game, imported_at)
                insert_metrics(connection, game, imported_at)
                upsert_scores(connection, game, imported_at)
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
                if playable_game:
                    upsert_job(connection, appid, "storefront", "english", "us", bool(state["english_complete"]), None, imported_at)
                    upsert_job(connection, appid, "storefront", "schinese", "cn", bool(state["chinese_complete"]), None, imported_at)

            for catalog_name in ("discovery", "search", "playable", "labeling"):
                connection.execute("DELETE FROM catalog_memberships WHERE catalog = ?", (catalog_name,))
            for game in catalog_rows:
                connection.execute(
                    "INSERT INTO catalog_memberships(catalog, appid, included_at, reason) VALUES ('discovery', ?, ?, 'SteamSpy candidate')",
                    (int(game["appId"]), imported_at),
                )
            for appid in playable:
                connection.execute(
                    "INSERT INTO catalog_memberships(catalog, appid, included_at, reason) VALUES ('search', ?, ?, 'current searchable catalog')",
                    (appid, imported_at),
                )
                connection.execute(
                    "INSERT INTO catalog_memberships(catalog, appid, included_at, reason) VALUES ('playable', ?, ?, 'current answer pool')",
                    (appid, imported_at),
                )
            for appid in labeling:
                connection.execute(
                    "INSERT INTO catalog_memberships(catalog, appid, included_at, reason) VALUES ('labeling', ?, ?, 'current labeling catalog')",
                    (appid, imported_at),
                )

            for key, value in {
                "schema_version": "1",
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
        "searchable": scalar(connection, "SELECT COUNT(*) FROM catalog_memberships WHERE catalog = 'search'"),
        "playable": scalar(connection, "SELECT COUNT(*) FROM catalog_memberships WHERE catalog = 'playable'"),
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
    parser.add_argument("--labeling", type=Path, default=DEFAULT_LABELING)
    args = parser.parse_args()
    stats = import_catalog(args.db, args.catalog, args.playable, args.labeling)
    print(f"db={args.db}")
    print(" ".join(f"{key}={value}" for key, value in stats.items()))


if __name__ == "__main__":
    main()
