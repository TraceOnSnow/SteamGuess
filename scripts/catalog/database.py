"""SQLite helpers for the persistent Steam catalog."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 11
SCHEMA_PATH = Path(__file__).with_name("schema.sql")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize(connection: sqlite3.Connection) -> None:
    connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    # v2 formalizes the incremental enrichment model.  The schema file is
    # intentionally additive so a fresh database and an existing v1 database
    # converge on the same shape.
    applied = {row[0] for row in connection.execute("SELECT version FROM schema_migrations")}
    if 2 not in applied:
        connection.execute("UPDATE app_prices SET current_cents = NULL, discount_percent = NULL")
        connection.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
            (2, utc_now()),
        )
    if 3 not in applied:
        # SQLite cannot alter a CHECK constraint in place. Rebuild the bounded
        # review snapshot table so each language can retain up to 100 rows.
        connection.executescript(
            """
            ALTER TABLE app_reviews RENAME TO app_reviews_v2;
            DROP INDEX IF EXISTS idx_app_reviews_app;
            CREATE TABLE app_reviews (
                appid INTEGER NOT NULL REFERENCES apps(appid) ON DELETE CASCADE,
                language TEXT NOT NULL CHECK (language IN ('english', 'schinese')),
                position INTEGER NOT NULL CHECK (position >= 1 AND position <= 100),
                review_id TEXT NOT NULL,
                review_text TEXT NOT NULL,
                voted_up INTEGER,
                votes_up INTEGER,
                votes_funny INTEGER,
                weighted_vote_score REAL,
                timestamp_created INTEGER,
                timestamp_updated INTEGER,
                source TEXT NOT NULL,
                retrieved_at TEXT NOT NULL,
                review_hash TEXT NOT NULL,
                PRIMARY KEY (appid, language, position),
                UNIQUE (appid, language, review_hash)
            );
            INSERT INTO app_reviews(
                appid, language, position, review_id, review_text, voted_up,
                votes_up, votes_funny, weighted_vote_score, timestamp_created,
                timestamp_updated, source, retrieved_at, review_hash
            )
            SELECT
                appid, language, position, review_id, review_text, voted_up,
                votes_up, votes_funny, weighted_vote_score, timestamp_created,
                timestamp_updated, source, retrieved_at, review_hash
            FROM app_reviews_v2;
            DROP TABLE app_reviews_v2;
            CREATE INDEX idx_app_reviews_app ON app_reviews(appid, language, position);
            """
        )
        connection.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
            (3, utc_now()),
        )
    if 4 not in applied:
        # The additive schema already creates difficulty_overrides.
        connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
            (4, utc_now()),
        )
    if 5 not in applied:
        # Independent AI candidates are stored separately from editorial
        # overrides.
        connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
            (5, utc_now()),
        )
    if 6 not in applied:
        # The one-off curated pool was an early seeding experiment. Difficulty
        # now uses the normalized candidate and override tables.
        connection.execute("DROP TABLE IF EXISTS curated_pool_entries")
        connection.execute("DELETE FROM catalog_memberships WHERE catalog LIKE 'curated:%'")
        connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
            (6, utc_now()),
        )
    if 7 not in applied:
        # Editorial catalog exclusions are deliberately independent from
        # imported eligibility flags so weekly refreshes cannot undo them.
        connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
            (7, utc_now()),
        )
    if 8 not in applied:
        # Add the 0-14 beginner tier to databases created before v8. Fresh
        # databases already use the current CHECK constraints from schema.sql.
        ai_schema = connection.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'difficulty_ai_candidates'"
        ).fetchone()
        if ai_schema and "'beginner'" not in str(ai_schema[0]):
            connection.executescript(
                """
                DROP INDEX IF EXISTS idx_difficulty_ai_candidates_priority;
                ALTER TABLE difficulty_ai_candidates RENAME TO difficulty_ai_candidates_v7;
                CREATE TABLE difficulty_ai_candidates (
                    appid INTEGER PRIMARY KEY REFERENCES apps(appid) ON DELETE CASCADE,
                    score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
                    level TEXT NOT NULL CHECK (level IN ('beginner', 'easy', 'normal', 'hard', 'hell')),
                    confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
                    reason TEXT NOT NULL,
                    eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
                    exclusion_reason TEXT,
                    review_priority TEXT NOT NULL CHECK (review_priority IN ('high', 'normal', 'low')),
                    model TEXT NOT NULL,
                    prompt_version TEXT NOT NULL,
                    evaluated_at TEXT NOT NULL,
                    source_path TEXT NOT NULL
                );
                INSERT INTO difficulty_ai_candidates
                SELECT * FROM difficulty_ai_candidates_v7;
                DROP TABLE difficulty_ai_candidates_v7;
                CREATE INDEX idx_difficulty_ai_candidates_priority
                    ON difficulty_ai_candidates(review_priority, eligible, score);
                """
            )
        connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
            (8, utc_now()),
        )
    if 9 not in applied:
        # review_redactions is now canonical schema rather than a table created
        # only when the first AI-redaction checkpoint is imported.
        connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
            (9, utc_now()),
        )
    if 10 not in applied:
        connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
            (10, utc_now()),
        )
    if 11 not in applied:
        # Legacy derived scores no longer participate in catalog ordering or
        # difficulty. SteamSpy source order defines the discovery ranking.
        connection.execute("DROP TABLE IF EXISTS app_scores")
        connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
            (11, utc_now()),
        )
    connection.execute(
        "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
        (SCHEMA_VERSION, utc_now()),
    )


def json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def payload_sha256(value: Any) -> str:
    return hashlib.sha256(json_text(value).encode("utf-8")).hexdigest()


def catalog_exclusion_ids(connection: sqlite3.Connection) -> set[int]:
    """Return AppIDs manually excluded from the active/playable catalog."""
    return {
        int(row["appid"])
        for row in connection.execute("SELECT appid FROM catalog_exclusions")
    }


def partition_catalog_rows(
    games: list[dict[str, Any]],
    excluded_appids: set[int],
    active_limit: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """Split ranked rows while allowing lower-ranked games to replace exclusions."""
    eligible = [game for game in games if int(game["appId"]) not in excluded_appids]
    excluded = [game for game in games if int(game["appId"]) in excluded_appids]
    limit = max(0, active_limit)
    return eligible[:limit], eligible[limit:], excluded


def replace_ranked_memberships(
    connection: sqlite3.Connection,
    games: list[dict[str, Any]],
    searchable_appids: set[int],
    playable_appids: set[int],
    active_limit: int,
    included_at: str,
) -> tuple[set[int], set[int], set[int]]:
    """Atomically align active/reserve/excluded and runtime memberships."""
    for catalog in ("active", "reserve", "search", "playable", "excluded"):
        connection.execute("DELETE FROM catalog_memberships WHERE catalog = ?", (catalog,))

    active_rows, reserve_rows, excluded_rows = partition_catalog_rows(
        games, catalog_exclusion_ids(connection), active_limit
    )
    groups = (
        ("active", active_rows, f"SteamSpy rank window; active_limit={active_limit}"),
        ("reserve", reserve_rows, f"Outside SteamSpy rank window; active_limit={active_limit}"),
        ("excluded", excluded_rows, "Editorial catalog exclusion"),
    )
    for membership, rows, reason in groups:
        connection.executemany(
            "INSERT INTO catalog_memberships(catalog, appid, included_at, reason) VALUES (?, ?, ?, ?)",
            [
                (membership, int(game["appId"]), included_at, reason)
                for game in rows
            ],
        )

    active_ids = {int(game["appId"]) for game in active_rows}
    search_ids = searchable_appids.intersection(active_ids)
    answer_ids = playable_appids.intersection(search_ids)
    for catalog, appids, reason in (
        ("search", search_ids, "current searchable catalog"),
        ("playable", answer_ids, "current answer pool"),
    ):
        connection.executemany(
            "INSERT INTO catalog_memberships(catalog, appid, included_at, reason) VALUES (?, ?, ?, ?)",
            [(catalog, appid, included_at, reason) for appid in sorted(appids)],
        )
    return active_ids, {int(game["appId"]) for game in reserve_rows}, {
        int(game["appId"]) for game in excluded_rows
    }
