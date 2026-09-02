#!/usr/bin/env python3
"""Aggregate valid player feedback into the canonical ``games`` table.

Difficulty is editorial/player data, not source metadata.  The convergence
migration starts these fields empty; this job is the only batch path that can
later update them.  Locked rows keep their score and only receive refreshed
feedback statistics.
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

from scripts.catalog.database import connect, initialize, level_for_score, utc_now


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
                feedback.id, feedback.player_id, feedback.app_id, feedback.score,
                feedback.level, feedback.created_at,
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
              AND feedback.score BETWEEN 0 AND 100
        )
        SELECT id, player_id, app_id, score, level, created_at
        FROM ranked
        WHERE feedback_rank = 1
        ORDER BY app_id, player_id
        """
    ).fetchall()
    grouped: dict[int, list[Feedback]] = defaultdict(list)
    for row in rows:
        grouped[int(row["app_id"])].append(Feedback(
            player_id=str(row["player_id"]),
            appid=int(row["app_id"]),
            score=float(row["score"]),
            level=str(row["level"]),
            created_at=str(row["created_at"]),
            feedback_id=int(row["id"]),
        ))
    return grouped


def population_stddev(scores: list[float], mean: float) -> float:
    return math.sqrt(sum((score - mean) ** 2 for score in scores) / len(scores)) if scores else 0.0


def clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, value))


def feedback_digest(values: list[Feedback]) -> str:
    payload = [
        [value.feedback_id, value.player_id, value.score, value.level, value.created_at]
        for value in values
    ]
    return hashlib.sha256(json.dumps(payload, separators=(",", ":")).encode()).hexdigest()


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
            SELECT difficulty_score, difficulty_locked, player_feedback_count,
                   player_feedback_mean, player_feedback_stddev,
                   player_feedback_updated_at
            FROM games WHERE appid = ?
            """,
            (appid,),
        ).fetchone()
        if row is None:
            counters["missingCatalog"] += 1
            continue
        scores = [value.score for value in feedback_rows]
        sample_count = len(scores)
        mean = sum(scores) / sample_count
        stddev = population_stddev(scores, mean)
        digest = feedback_digest(feedback_rows)
        unchanged_stats = (
            row["player_feedback_count"] == sample_count
            and row["player_feedback_mean"] is not None
            and abs(float(row["player_feedback_mean"]) - mean) < 1e-9
            and row["player_feedback_stddev"] is not None
            and abs(float(row["player_feedback_stddev"]) - stddev) < 1e-9
            and row["player_feedback_updated_at"] == digest
        )
        if unchanged_stats:
            counters["unchanged"] += 1
            continue

        locked = bool(row["difficulty_locked"])
        previous_score = float(row["difficulty_score"]) if row["difficulty_score"] is not None else None
        base_score = previous_score if previous_score is not None else mean
        candidate = clamp(
            (prior_weight * base_score + sample_count * mean) / (prior_weight + sample_count)
            if prior_weight + sample_count else mean,
            0,
            100,
        )
        if locked:
            status, result_score = "locked", previous_score
        elif sample_count < min_samples:
            status, result_score = "insufficient", previous_score
        elif stddev > max_stddev:
            status, result_score = "review", previous_score
        else:
            status = "applied"
            result_score = clamp(candidate, base_score - max_delta, base_score + max_delta)
            result_score = round(clamp(result_score, 0, 100))

        counters[status] += 1
        change = {
            "appId": appid,
            "status": status,
            "baseScore": round(base_score, 3),
            "candidateScore": round(candidate, 3),
            "resultScore": result_score,
            "sampleCount": sample_count,
            "meanScore": round(mean, 3),
            "stddev": round(stddev, 3),
        }
        changes.append(change)
        if not apply:
            continue

        sets = [
            "player_feedback_count = ?",
            "player_feedback_mean = ?",
            "player_feedback_stddev = ?",
            "player_feedback_updated_at = ?",
        ]
        values: list[Any] = [sample_count, mean, stddev, digest]
        if status == "applied" and result_score is not None:
            sets.extend(["difficulty_score = ?", "difficulty_tier = ?", "difficulty_source = ?"])
            values.extend([result_score, level_for_score(result_score), "player_feedback"])
        values.append(appid)
        catalog.execute(f"UPDATE games SET {', '.join(sets)}, updated_at = ? WHERE appid = ?", [
            *values[:-1], now, values[-1],
        ])
    if apply:
        catalog.execute(
            """
            INSERT INTO catalog_meta(key, value, updated_at) VALUES
                ('difficulty_feedback_revision', ?, ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
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
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.min_samples < 1 or min(args.prior_weight, args.max_delta, args.max_stddev) < 0:
        parser.error("feedback thresholds must be non-negative and min-samples must be positive")
    runtime_path, catalog_path = Path(args.runtime_db), Path(args.catalog_db)
    if not runtime_path.exists() or not catalog_path.exists():
        parser.error("runtime and catalog databases must exist")
    runtime, catalog = connect(runtime_path), connect(catalog_path)
    try:
        initialize(catalog)
        result = synchronize(
            runtime, catalog, apply=args.apply, min_samples=args.min_samples,
            prior_weight=args.prior_weight, max_delta=args.max_delta,
            max_stddev=args.max_stddev,
        )
    finally:
        runtime.close()
        catalog.close()
    print(json.dumps({key: value for key, value in result.items() if key != "changes"}, indent=2))
    for change in result["changes"][:20]:
        print(
            f"appid={change['appId']} status={change['status']} n={change['sampleCount']} "
            f"mean={change['meanScore']} {change['baseScore']}->{change['resultScore']}"
        )


if __name__ == "__main__":
    main()
