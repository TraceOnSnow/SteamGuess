#!/usr/bin/env python3
"""Import successful review-redaction checkpoints into a SQLite sidecar table."""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from scripts.catalog.redact_reviews_ai import _record_key, _load_json_records, read_jsonl

DEFAULT_DB = "data/catalog/catalog.sqlite"
DEFAULT_INPUT = "data/analysis/review-redaction/review_redactions.jsonl"
TABLE = "review_redactions"
REQUIRED_COLUMNS = {
    "task_id",
    "appid",
    "language",
    "review_id",
    "review_hash",
    "redacted_text",
    "entities_json",
    "model",
    "prompt_version",
    "processed_at",
    "imported_at",
    "source_path",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_checkpoint(path: Path) -> list[dict[str, Any]]:
    records = read_jsonl(path) if path.suffix.lower() == ".jsonl" else _load_json_records(path)
    # Checkpoints are append-only while running. Import only the final state for
    # each task while retaining deterministic first-seen order.
    latest = {_record_key(record): record for record in records}
    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for record in records:
        key = _record_key(record)
        if key not in seen:
            seen.add(key)
            result.append(latest[key])
    return result


def table_exists(connection: sqlite3.Connection, name: str) -> bool:
    return connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (name,),
    ).fetchone() is not None


def create_or_validate_table(connection: sqlite3.Connection) -> None:
    if not table_exists(connection, TABLE):
        connection.executescript(
            """
            CREATE TABLE review_redactions (
                task_id TEXT PRIMARY KEY,
                appid INTEGER NOT NULL,
                language TEXT NOT NULL,
                review_id TEXT NOT NULL,
                review_hash TEXT NOT NULL,
                redacted_text TEXT NOT NULL,
                entities_json TEXT NOT NULL,
                model TEXT NOT NULL,
                prompt_version TEXT NOT NULL,
                processed_at TEXT NOT NULL,
                imported_at TEXT NOT NULL,
                source_path TEXT NOT NULL
            );
            CREATE INDEX idx_review_redactions_review
                ON review_redactions(appid, language, review_id);
            """
        )
        return
    columns = {str(row[1]) for row in connection.execute(f"PRAGMA table_info({TABLE})")}
    missing = REQUIRED_COLUMNS - columns
    if missing:
        raise ValueError(
            f"existing {TABLE} table is incompatible; missing columns: {', '.join(sorted(missing))}"
        )


def _validated_record(record: dict[str, Any]) -> dict[str, Any] | None:
    if record.get("status") != "ok":
        return None
    try:
        appid = int(record["appId"])
    except (KeyError, TypeError, ValueError):
        return None
    language = record.get("language")
    source_hash = record.get("sourceHash")
    redacted_text = record.get("redactedText")
    entities = record.get("entities", [])
    if (
        language not in {"english", "schinese"}
        or not isinstance(source_hash, str)
        or not re.fullmatch(r"[0-9a-f]{64}", source_hash)
        or not isinstance(redacted_text, str)
        or not redacted_text.strip()
        or not isinstance(entities, list)
    ):
        return None
    return {
        "task_id": _record_key(record),
        "appid": appid,
        "language": language,
        "review_id": str(record.get("reviewId") or ""),
        "review_hash": source_hash,
        "redacted_text": redacted_text,
        "entities_json": json.dumps(entities, ensure_ascii=False, separators=(",", ":"), sort_keys=True),
        "model": str(record.get("model") or ""),
        "prompt_version": str(record.get("promptVersion") or ""),
        "processed_at": str(record.get("updatedAt") or ""),
    }


def _review_state(
    connection: sqlite3.Connection,
    record: dict[str, Any],
    has_reviews: bool,
) -> str:
    if not has_reviews:
        return "current"
    if record["review_id"]:
        row = connection.execute(
            """
            SELECT review_hash
            FROM app_reviews
            WHERE appid = ? AND language = ? AND review_id = ?
            LIMIT 1
            """,
            (record["appid"], record["language"], record["review_id"]),
        ).fetchone()
    else:
        row = connection.execute(
            """
            SELECT review_hash
            FROM app_reviews
            WHERE appid = ? AND language = ? AND review_hash = ?
            LIMIT 1
            """,
            (record["appid"], record["language"], record["review_hash"]),
        ).fetchone()
    if row is None:
        return "missing"
    return "current" if str(row[0]) == record["review_hash"] else "stale"


def import_records(
    connection: sqlite3.Connection,
    records: list[dict[str, Any]],
    *,
    source_path: str,
    dry_run: bool = False,
) -> dict[str, int]:
    stats = {
        "records": len(records),
        "eligible": 0,
        "imported": 0,
        "notOk": 0,
        "invalid": 0,
        "stale": 0,
        "missing": 0,
    }
    has_reviews = table_exists(connection, "app_reviews")
    imported_at = utc_now()
    prepared: list[dict[str, Any]] = []
    for raw in records:
        if raw.get("status") != "ok":
            stats["notOk"] += 1
            continue
        record = _validated_record(raw)
        if record is None:
            stats["invalid"] += 1
            continue
        stats["eligible"] += 1
        state = _review_state(connection, record, has_reviews)
        if state != "current":
            stats[state] += 1
            continue
        prepared.append(record)

    if dry_run:
        stats["imported"] = len(prepared)
        return stats

    create_or_validate_table(connection)
    for record in prepared:
        connection.execute(
            """
            INSERT INTO review_redactions(
                task_id, appid, language, review_id, review_hash, redacted_text,
                entities_json, model, prompt_version, processed_at, imported_at,
                source_path
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(task_id) DO UPDATE SET
                appid = excluded.appid,
                language = excluded.language,
                review_id = excluded.review_id,
                review_hash = excluded.review_hash,
                redacted_text = excluded.redacted_text,
                entities_json = excluded.entities_json,
                model = excluded.model,
                prompt_version = excluded.prompt_version,
                processed_at = excluded.processed_at,
                imported_at = excluded.imported_at,
                source_path = excluded.source_path
            """,
            (
                record["task_id"],
                record["appid"],
                record["language"],
                record["review_id"],
                record["review_hash"],
                record["redacted_text"],
                record["entities_json"],
                record["model"],
                record["prompt_version"],
                record["processed_at"],
                imported_at,
                source_path,
            ),
        )
    stats["imported"] = len(prepared)
    return stats


def run(args: argparse.Namespace) -> dict[str, int]:
    source = Path(args.input)
    database = Path(args.db)
    if not source.exists():
        raise ValueError(f"checkpoint does not exist: {source}")
    if not database.exists():
        raise ValueError(f"database does not exist: {database}")
    records = load_checkpoint(source)
    if args.limit < 0:
        raise ValueError("--limit must be non-negative")
    if args.limit:
        records = records[: args.limit]
    connection = sqlite3.connect(database)
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        if args.dry_run:
            stats = import_records(connection, records, source_path=str(source), dry_run=True)
        else:
            with connection:
                stats = import_records(connection, records, source_path=str(source), dry_run=False)
    finally:
        connection.close()
    print(json.dumps({**stats, "dryRun": args.dry_run, "db": str(database)}, ensure_ascii=False))
    return stats


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", default=DEFAULT_INPUT, help="Redaction .json or .jsonl checkpoint")
    parser.add_argument("--db", default=DEFAULT_DB, help="Existing SQLite catalog database")
    parser.add_argument("--limit", type=int, default=0, help="Maximum final checkpoint records; 0 means all")
    parser.add_argument("--dry-run", action="store_true", help="Validate and report without creating or writing tables")
    return parser


def main() -> None:
    try:
        run(build_parser().parse_args())
    except (OSError, ValueError, json.JSONDecodeError, sqlite3.Error) as error:
        raise SystemExit(f"error: {error}") from error


if __name__ == "__main__":
    main()
