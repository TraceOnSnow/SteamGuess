#!/usr/bin/env python3
"""Backfill selected IGDB PopScore metrics for an existing game union.

The normal popularity fetcher asks IGDB for the global Top-N of one metric.
This tool does the complementary operation: it takes the existing union of
game IDs and asks IGDB for each configured metric only for those IDs. This
removes the artificial "outside Top 3000 means zero" gap before ranking.

Missing rows are kept missing. In particular, IGDB's Steam-derived metrics
(24hr Peak Players and Total Reviews) are naturally absent for games without
Steam coverage and must not be converted to zero by this script.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

from scripts.catalog.fetch_igdb_popularity import (
    DEFAULT_ENV_FILE,
    credentials,
    fetch_access_token,
    fetch_popularity_types,
    request_json,
    resolve_popularity_type,
    write_json,
)


DEFAULT_INPUT = Path("data/analysis/igdb-heat-all.json")
DEFAULT_OUTPUT_DIR = Path("data/analysis/igdb-popularity-backfilled")
POPULARITY_METRICS = (
    ("1", "visits"),
    ("3", "playing"),
    ("4", "played"),
    ("5", "peak-players"),
    ("8", "total-reviews"),
)
API_URL = "https://api.igdb.com/v4/popularity_primitives"


def load_target_games(path: Path) -> dict[int, str]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = payload.get("rows") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise ValueError(f"{path} does not contain a ranking payload with rows")
    games: dict[int, str] = {}
    for row in rows:
        if not isinstance(row, dict) or row.get("igdbGameId") is None:
            continue
        game_id = int(row["igdbGameId"])
        games.setdefault(game_id, str(row.get("name") or ""))
    if not games:
        raise ValueError(f"{path} contains no IGDB game IDs")
    return games


def fetch_target_page(
    token: str,
    client_id: str,
    game_ids: list[int],
    popularity_type: int,
    *,
    timeout: int,
    retries: int,
    retry_delay: float,
) -> list[dict[str, Any]]:
    ids = ",".join(str(game_id) for game_id in sorted(set(game_ids)))
    query = (
        "fields game_id,value,popularity_type,calculated_at;"
        f"where popularity_type = {popularity_type} & game_id = ({ids});"
        f"limit {len(set(game_ids))};"
    ).encode("utf-8")
    payload = request_json(
        API_URL,
        method="POST",
        data=query,
        headers={
            "Client-ID": client_id,
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "text/plain",
        },
        timeout=timeout,
        retries=retries,
        retry_delay=retry_delay,
    )
    if not isinstance(payload, list):
        raise RuntimeError("IGDB popularity_primitives response was not an array")
    return [row for row in payload if isinstance(row, dict)]


def snapshot_path(output_dir: Path, metric_id: str, slug: str) -> Path:
    return output_dir / f"{metric_id}-{slug}.json"


def checkpoint_path(output_dir: Path, metric_id: str, slug: str) -> Path:
    return output_dir / "checkpoints" / f"{metric_id}-{slug}.json"


def fetch_metric(
    *,
    token: str,
    client_id: str,
    metric_id: str,
    slug: str,
    metric_name: str,
    target_games: dict[int, str],
    output_dir: Path,
    batch_size: int,
    delay: float,
    timeout: int,
    retries: int,
    retry_delay: float,
    resume: bool,
) -> Path:
    checkpoint = checkpoint_path(output_dir, metric_id, slug)
    output = snapshot_path(output_dir, metric_id, slug)
    rows_by_id: dict[int, dict[str, Any]] = {}

    if resume and checkpoint.exists():
        saved = json.loads(checkpoint.read_text(encoding="utf-8"))
        for row in saved.get("rows", []):
            if isinstance(row, dict) and row.get("igdbGameId") is not None:
                rows_by_id[int(row["igdbGameId"])] = row
        print(
            f"[{metric_name}] resumed={len(rows_by_id)} "
            f"checkpoint={checkpoint}",
            flush=True,
        )

    target_ids = sorted(target_games)
    missing_ids = [game_id for game_id in target_ids if game_id not in rows_by_id]
    total_batches = (len(target_ids) + batch_size - 1) // batch_size
    completed_batches = (
        (len(target_ids) - len(missing_ids) + batch_size - 1) // batch_size
        if rows_by_id
        else 0
    )

    for index in range(0, len(missing_ids), batch_size):
        if rows_by_id or index:
            time.sleep(delay)
        batch = missing_ids[index : index + batch_size]
        response_rows = fetch_target_page(
            token,
            client_id,
            batch,
            int(metric_id),
            timeout=timeout,
            retries=retries,
            retry_delay=retry_delay,
        )
        for source_row in response_rows:
            if source_row.get("game_id") is None:
                continue
            game_id = int(source_row["game_id"])
            if game_id not in target_games:
                continue
            rows_by_id[game_id] = {
                "rank": None,
                "igdbGameId": game_id,
                "name": target_games[game_id],
                "popularityType": metric_name,
                "popularityTypeId": int(metric_id),
                "value": source_row.get("value"),
                "calculatedAt": source_row.get("calculated_at"),
            }
        completed_batches += 1
        checkpoint_payload = {
            "schemaVersion": 1,
            "source": "igdb.popularity_primitives.targeted",
            "popularityType": {"id": int(metric_id), "name": metric_name},
            "targetGameCount": len(target_games),
            "rows": sorted(rows_by_id.values(), key=lambda row: row["igdbGameId"]),
        }
        write_json(checkpoint, checkpoint_payload)
        print(
            f"[{metric_name}] batch={completed_batches}/{total_batches} "
            f"returned={len(response_rows)} collected={len(rows_by_id)}",
            flush=True,
        )

    ranked_rows = sorted(
        rows_by_id.values(),
        key=lambda row: (
            -(float(row.get("value") or 0)),
            row["igdbGameId"],
        ),
    )
    for rank, row in enumerate(ranked_rows, start=1):
        row["rank"] = rank
    payload = {
        "schemaVersion": 1,
        "source": "igdb.popularity_primitives.targeted",
        "metric": "popscore",
        "valueSemantics": (
            "IGDB PopScore primitive value; targeted to the existing "
            "SteamGuess game union"
        ),
        "popularityType": {"id": int(metric_id), "name": metric_name},
        "targetGameCount": len(target_games),
        "fetchedRows": len(ranked_rows),
        "missingRows": len(target_games) - len(ranked_rows),
        "rows": ranked_rows,
    }
    write_json(output, payload)
    return output


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Backfill IGDB popularity metrics for an existing game union."
    )
    parser.add_argument("--env-file", type=Path, default=DEFAULT_ENV_FILE)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--batch-size", type=int, default=500)
    parser.add_argument("--delay", type=float, default=0.35)
    parser.add_argument("--timeout", type=int, default=45)
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--retry-delay", type=float, default=5.0)
    parser.add_argument("--no-resume", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not 1 <= args.batch_size <= 500:
        raise SystemExit("--batch-size must be between 1 and 500")
    if args.delay < 0:
        raise SystemExit("--delay must be non-negative")

    target_games = load_target_games(args.input)
    client_id, client_secret = credentials(args.env_file)
    token = fetch_access_token(
        client_id,
        client_secret,
        timeout=args.timeout,
        retries=args.retries,
        retry_delay=args.retry_delay,
    )
    available = fetch_popularity_types(
        token,
        client_id,
        timeout=args.timeout,
        retries=args.retries,
        retry_delay=args.retry_delay,
    )
    args.output_dir.mkdir(parents=True, exist_ok=True)
    print(f"target_games={len(target_games)}", flush=True)

    for requested_id, slug in POPULARITY_METRICS:
        metric_id, metric_name = resolve_popularity_type(requested_id, available)
        path = fetch_metric(
            token=token,
            client_id=client_id,
            metric_id=str(metric_id),
            slug=slug,
            metric_name=metric_name,
            target_games=target_games,
            output_dir=args.output_dir,
            batch_size=args.batch_size,
            delay=args.delay,
            timeout=args.timeout,
            retries=args.retries,
            retry_delay=args.retry_delay,
            resume=not args.no_resume,
        )
        print(f"[{metric_name}] wrote={path}", flush=True)


if __name__ == "__main__":
    main()
