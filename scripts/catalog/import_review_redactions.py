#!/usr/bin/env python3
"""Import review-redaction checkpoints into the canonical ``games`` rows.

Review text is stored as JSON on ``games``. The original text remains in each
review object and in ``raw_reviews_json``; only the derived hint fields are
added beside it. No redaction sidecar table is created.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from scripts.catalog.redact_reviews_ai import _load_json_records, _record_key, read_jsonl

DEFAULT_DB = "data/catalog/catalog.sqlite"
DEFAULT_INPUT = "data/analysis/review-redaction/review_redactions.jsonl"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_checkpoint(path: Path) -> list[dict[str, Any]]:
    records = read_jsonl(path) if path.suffix.lower() == ".jsonl" else _load_json_records(path)
    latest = {_record_key(record): record for record in records}
    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for record in records:
        key = _record_key(record)
        if key not in seen:
            seen.add(key)
            result.append(latest[key])
    return result


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
        "entities": entities,
        "model": str(record.get("model") or ""),
        "prompt_version": str(record.get("promptVersion") or ""),
        "processed_at": str(record.get("updatedAt") or ""),
    }


def _review_column(language: str) -> str:
    return "reviews_en_json" if language == "english" else "reviews_zh_json"


def _review_text(item: dict[str, Any]) -> str:
    return str(item.get("text") or item.get("review") or "")


def _find_review(
    connection: Any,
    record: dict[str, Any],
) -> tuple[Any, list[dict[str, Any]], dict[str, Any]] | None:
    row = connection.execute(
        f"SELECT appid, {_review_column(record['language'])} AS reviews_json "
        "FROM games WHERE appid = ?",
        (record["appid"],),
    ).fetchone()
    if row is None:
        return None
    try:
        reviews = json.loads(row["reviews_json"] or "[]")
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(reviews, list):
        return None
    for item in reviews:
        if not isinstance(item, dict):
            continue
        review_id = str(item.get("reviewId") or item.get("recommendationid") or "")
        source_hash = hashlib.sha256(_review_text(item).encode("utf-8")).hexdigest()
        if (
            (record["review_id"] and review_id == record["review_id"])
            or (not record["review_id"] and source_hash == record["review_hash"])
        ):
            return row, reviews, item
    return None


def import_records(
    connection: Any,
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
        found = _find_review(connection, record)
        if found is None:
            stats["missing"] += 1
            continue
        _row, _reviews, item = found
        current_hash = hashlib.sha256(_review_text(item).encode("utf-8")).hexdigest()
        if current_hash != record["review_hash"]:
            stats["stale"] += 1
            continue
        prepared.append(record)

    if dry_run:
        stats["imported"] = len(prepared)
        return stats

    imported_at = utc_now()
    # Group updates so a game containing several reviews is written once.
    grouped: dict[tuple[int, str], list[dict[str, Any]]] = {}
    for record in prepared:
        grouped.setdefault((record["appid"], record["language"]), []).append(record)

    for (appid, language), game_records in grouped.items():
        column = _review_column(language)
        found = _find_review(connection, game_records[0])
        if found is None:
            continue
        _row, reviews, _ = found
        by_id = {
            str(item.get("reviewId") or item.get("recommendationid") or ""): item
            for item in reviews
            if isinstance(item, dict)
        }
        for record in game_records:
            target = None
            if record["review_id"]:
                target = by_id.get(record["review_id"])
            else:
                target = next(
                    (
                        item for item in reviews
                        if isinstance(item, dict)
                        and hashlib.sha256(_review_text(item).encode("utf-8")).hexdigest()
                        == record["review_hash"]
                    ),
                    None,
                )
            if target is None:
                continue
            target["redactedText"] = record["redacted_text"]
            target["redactionEntities"] = record["entities"]
            target["redactionModel"] = record["model"]
            target["redactionPromptVersion"] = record["prompt_version"]
            target["redactedAt"] = record["processed_at"] or imported_at
            target["redactionSource"] = source_path
        connection.execute(
            f"UPDATE games SET {column} = ?, updated_at = ? WHERE appid = ?",
            (json.dumps(reviews, ensure_ascii=False, separators=(",", ":")), imported_at, appid),
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

    import sqlite3

    connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    try:
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
    parser.add_argument("--dry-run", action="store_true", help="Validate and report without writing games")
    return parser


def main() -> None:
    try:
        run(build_parser().parse_args())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"error: {error}") from error


if __name__ == "__main__":
    main()
