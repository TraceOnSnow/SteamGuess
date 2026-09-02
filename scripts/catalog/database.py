"""SQLite helpers for the single-row-per-game catalog."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 13
SCHEMA_PATH = Path(__file__).with_name("schema.sql")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 5000")
    return connection


def table_exists(connection: sqlite3.Connection, name: str) -> bool:
    return bool(connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)
    ).fetchone())


def initialize(connection: sqlite3.Connection) -> None:
    connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    # A legacy catalog is intentionally not copied implicitly.  The explicit
    # migrate_catalog.py command creates a backup, verifies every AppID and
    # then atomically replaces the database.  This prevents a server restart
    # from silently doing a multi-minute destructive migration.
    connection.execute(
        "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
        (SCHEMA_VERSION, utc_now()),
    )


def json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def json_load(value: str | None, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return default


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def payload_sha256(value: Any) -> str:
    return hashlib.sha256(json_text(value).encode("utf-8")).hexdigest()


def catalog_exclusion_ids(connection: sqlite3.Connection) -> set[int]:
    if not table_exists(connection, "games"):
        return set()
    return {
        int(row["appid"])
        for row in connection.execute("SELECT appid FROM games WHERE pool_status = 'excluded'")
    }


def partition_catalog_rows(
    games: list[dict[str, Any]],
    excluded_appids: set[int],
    active_limit: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    eligible = [game for game in games if int(game["appId"]) not in excluded_appids]
    excluded = [game for game in games if int(game["appId"]) in excluded_appids]
    limit = max(0, active_limit)
    return eligible[:limit], eligible[limit:], excluded


def level_for_score(score: float) -> str:
    if score < 15:
        return "beginner"
    if score < 25:
        return "easy"
    if score < 50:
        return "normal"
    if score < 75:
        return "hard"
    return "hell"


def is_non_game_type(value: Any) -> bool:
    """Return whether a Steam/PICS type is clearly not a game."""
    return str(value or "").strip().casefold() in {
        "application", "config", "demo", "hardware", "tool", "advertising",
        "video", "series", "episode", "music",
    }


def replace_ranked_memberships(
    connection: sqlite3.Connection,
    games: list[dict[str, Any]],
    searchable_appids: set[int],
    playable_appids: set[int],
    active_limit: int,
    included_at: str,
) -> tuple[set[int], set[int], set[int]]:
    """Compatibility helper for callers from the pre-convergence pipeline.

    Rank-window memberships no longer belong in the catalog database. The
    single ``games.pool_status`` column is the authority. The returned sets
    retain the old function's shape for scripts that only use its counters.
    """
    excluded = catalog_exclusion_ids(connection)
    active, reserve, excluded_rows = partition_catalog_rows(games, excluded, active_limit)
    return (
        {int(game["appId"]) for game in active},
        {int(game["appId"]) for game in reserve},
        {int(game["appId"]) for game in excluded_rows},
    )
