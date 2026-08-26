#!/usr/bin/env python3
"""Apply validated player difficulty feedback to the persistent catalog.

The runtime database keeps every submitted response. This batch job uses only
the latest response from each player/game pair and only when it belongs to a
completed matching game session. Accepted changes are deliberately gradual and
remain subordinate to locked editorial overrides.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sqlite3
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from scripts.catalog.database import connect, initialize, utc_now


@dataclass(frozen=True)
class Feedback:
    player_id: str
    appid: int
    score: float
    level: str
    created_at: str
    feedback_id: int


def latest_valid_feedback(runtime: sqlite3.Connection) -> dict[int, list[Feedback]]:
    rows = runtime.execute(
        """
        WITH ranked AS (
            SELECT
                feedback.id,
                feedback.player_id,
                feedback.app_id,
                feedback.score,
                feedback.level,
                feedback.created_at,
                ROW_NUMBER() OVER (
                    PARTITION BY feedback.player_id, feedback.app_id
                    ORDER BY feedback.created_at DESC, feedback.id DESC
                ) AS feedback_rank
            FROM difficulty_feedback AS feedback
            JOIN game_sessions AS session ON session.id = feedback.session_id
            WHERE feedback.player_id IS NOT NULL
              AND session.player_id = feedback.player_id
              AND session.answer_app_id = feedback.app_id
              AND session.finished_at IS NOT NULL
              AND session.outcome IN ('won', 'lost', 'surrendered')
        )
        SELECT id, player_id, app_id, score, level, created_at
        FROM ranked
        WHERE feedback_rank = 1
        ORDER BY app_id, player_id
        """
    ).fetchall()
    grouped: dict[int, list[Feedback]] = defaultdict(list)
    for row in rows:
        grouped[int(row["app_id"])].append(
            Feedback(
                player_id=str(row["player_id"]),
                appid=int(row["app_id"]),
                score=float(row["score"]),
                level=str(row["level"]),
                created_at=str(row["created_at"]),
                feedback_id=int(row["id"]),
            )
        )
    return grouped


def digest_feedback(
    rows: list[Feedback],
    *,
    locked: bool,
    min_samples: int,
    prior_weight: float,
    max_delta: float,
    max_stddev: float,
) -> str:
    payload = {
        "algorithm": "shrinkage-v1",
        "locked": locked,
        "minSamples": min_samples,
        "priorWeight": prior_weight,
        "maxDelta": max_delta,
        "maxStddev": max_stddev,
        "feedback": [
            {
                "id": row.feedback_id,
                "playerId": row.player_id,
                "score": row.score,
                "level": row.level,
                "createdAt": row.created_at,
            }
            for row in rows
        ],
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def population_stddev(scores: list[float], mean: float) -> float:
    if not scores:
        return 0.0
    return math.sqrt(sum((score - mean) ** 2 for score in scores) / len(scores))


def clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, value))


def synchronize(
    runtime: sqlite3.Connection,
    catalog: sqlite3.Connection,
    *,
    apply: bool,
    min_samples: int = 10,
    prior_weight: float = 20.0,
    max_delta: float = 3.0,
    max_stddev: float = 20.0,
    now: str | None = None,
) -> dict[str, Any]:
    now = now or utc_now()
    grouped = latest_valid_feedback(runtime)
    counters = {
        "gamesWithFeedback": len(grouped),
        "applied": 0,
        "review": 0,
        "insufficient": 0,
        "locked": 0,
        "unchanged": 0,
        "missingCatalog": 0,
    }
    changes: list[dict[str, Any]] = []

    for appid, feedback_rows in grouped.items():
        row = catalog.execute(
            """
            SELECT
                ai.score AS ai_score,
                ai.eligible AS ai_eligible,
                COALESCE(overrides.locked, 0) AS locked,
                previous.current_score AS previous_score,
                previous.source_digest AS previous_digest
            FROM apps
            LEFT JOIN difficulty_ai_candidates AS ai ON ai.appid = apps.appid
            LEFT JOIN difficulty_overrides AS overrides ON overrides.appid = apps.appid
            LEFT JOIN difficulty_feedback_scores AS previous ON previous.appid = apps.appid
            WHERE apps.appid = ?
            """,
            (appid,),
        ).fetchone()
        if row is None or row["ai_score"] is None or not bool(row["ai_eligible"]):
            counters["missingCatalog"] += 1
            continue

        locked = bool(row["locked"])
        source_digest = digest_feedback(
            feedback_rows,
            locked=locked,
            min_samples=min_samples,
            prior_weight=prior_weight,
            max_delta=max_delta,
            max_stddev=max_stddev,
        )
        if row["previous_digest"] == source_digest:
            counters["unchanged"] += 1
            continue

        scores = [item.score for item in feedback_rows]
        sample_count = len(scores)
        mean = sum(scores) / sample_count
        stddev = population_stddev(scores, mean)
        previous_score = float(row["previous_score"]) if row["previous_score"] is not None else None
        base_score = previous_score if previous_score is not None else float(row["ai_score"])
        candidate_score = clamp(
            (prior_weight * base_score + sample_count * mean) / (prior_weight + sample_count),
            0,
            100,
        )

        if locked:
            status = "locked"
            result_score = previous_score
        elif sample_count < min_samples:
            status = "insufficient"
            result_score = previous_score
        elif stddev > max_stddev:
            status = "review"
            result_score = previous_score
        else:
            status = "applied"
            result_score = clamp(candidate_score, base_score - max_delta, base_score + max_delta)
            result_score = clamp(result_score, 0, 100)

        counters[status] += 1
        change = {
            "appId": appid,
            "status": status,
            "baseScore": round(base_score, 3),
            "candidateScore": round(candidate_score, 3),
            "resultScore": None if result_score is None else round(result_score, 3),
            "sampleCount": sample_count,
            "meanScore": round(mean, 3),
            "stddev": round(stddev, 3),
            "sourceDigest": source_digest,
        }
        changes.append(change)
        if not apply:
            continue

        catalog.execute(
            """
            INSERT INTO difficulty_feedback_scores(
                appid, base_score, candidate_score, current_score, sample_count,
                mean_score, stddev, prior_weight, max_delta, status,
                source_digest, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(appid) DO UPDATE SET
                base_score = excluded.base_score,
                candidate_score = excluded.candidate_score,
                current_score = excluded.current_score,
                sample_count = excluded.sample_count,
                mean_score = excluded.mean_score,
                stddev = excluded.stddev,
                prior_weight = excluded.prior_weight,
                max_delta = excluded.max_delta,
                status = excluded.status,
                source_digest = excluded.source_digest,
                updated_at = excluded.updated_at
            """,
            (
                appid,
                base_score,
                candidate_score,
                result_score,
                sample_count,
                mean,
                stddev,
                prior_weight,
                max_delta,
                status,
                source_digest,
                now,
            ),
        )
        catalog.execute(
            """
            INSERT OR IGNORE INTO difficulty_feedback_history(
                appid, base_score, candidate_score, result_score, sample_count,
                mean_score, stddev, prior_weight, max_delta, status,
                source_digest, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                appid,
                base_score,
                candidate_score,
                result_score,
                sample_count,
                mean,
                stddev,
                prior_weight,
                max_delta,
                status,
                source_digest,
                now,
            ),
        )

    if apply:
        catalog.execute(
            """
            INSERT INTO catalog_meta(key, value, updated_at)
            VALUES ('difficulty_feedback_revision', ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            """,
            (now, now),
        )
        catalog.commit()

    return {**counters, "dryRun": not apply, "changes": changes}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-db", default="data/runtime/steamguess.sqlite")
    parser.add_argument("--catalog-db", default="data/catalog/catalog.sqlite")
    parser.add_argument("--min-samples", type=int, default=10)
    parser.add_argument("--prior-weight", type=float, default=20.0)
    parser.add_argument("--max-delta", type=float, default=3.0)
    parser.add_argument("--max-stddev", type=float, default=20.0)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true", help="Persist accepted adjustments")
    mode.add_argument("--dry-run", action="store_true", help="Preview without writing (default)")
    args = parser.parse_args()

    if args.min_samples < 1:
        parser.error("--min-samples must be at least 1")
    if args.prior_weight < 0 or args.max_delta < 0 or args.max_stddev < 0:
        parser.error("weights and thresholds must be non-negative")

    runtime_path = Path(args.runtime_db)
    catalog_path = Path(args.catalog_db)
    if not runtime_path.exists():
        parser.error(f"runtime database does not exist: {runtime_path}")
    if not catalog_path.exists():
        parser.error(f"catalog database does not exist: {catalog_path}")

    runtime = connect(runtime_path)
    catalog = connect(catalog_path)
    try:
        initialize(catalog)
        result = synchronize(
            runtime,
            catalog,
            apply=args.apply,
            min_samples=args.min_samples,
            prior_weight=args.prior_weight,
            max_delta=args.max_delta,
            max_stddev=args.max_stddev,
        )
    finally:
        runtime.close()
        catalog.close()

    printable = {key: value for key, value in result.items() if key != "changes"}
    print(json.dumps(printable, ensure_ascii=False, indent=2))
    for change in result["changes"][:20]:
        print(
            f"appid={change['appId']} status={change['status']} "
            f"n={change['sampleCount']} mean={change['meanScore']} "
            f"stddev={change['stddev']} {change['baseScore']}->{change['resultScore']}"
        )
    if len(result["changes"]) > 20:
        print(f"... {len(result['changes']) - 20} more changes")


if __name__ == "__main__":
    main()
