#!/usr/bin/env python3
"""Join selected IGDB popularity Top-N snapshots into one CSV.

The default comparison is:

* Played
* Playing
* 24hr Peak Players
* Total Reviews

The output is the union of the selected rankings. A game missing from one
ranking keeps empty fields for that metric.
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any


DEFAULT_INPUT_DIR = Path("data/analysis/igdb-popularity-top500")
DEFAULT_OUTPUT = Path("data/analysis/igdb-popularity-top100-joined.csv")
DEFAULT_TYPES = {
    4: "played",
    3: "playing",
    5: "peak_players",
    8: "total_reviews",
}


def load_snapshot(path: Path, limit: int) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} is not a JSON object")
    rows = payload.get("rows")
    popularity_type = payload.get("popularityType")
    if not isinstance(rows, list) or not isinstance(popularity_type, dict):
        raise ValueError(f"{path} is not an IGDB popularity snapshot")
    return {
        "id": int(popularity_type["id"]),
        "name": str(popularity_type.get("name") or ""),
        "rows": [row for row in rows[:limit] if isinstance(row, dict)],
    }


def find_snapshot(input_dir: Path, popularity_type_id: int) -> Path:
    candidates = []
    for path in input_dir.glob("*.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            if int(payload.get("popularityType", {}).get("id", -1)) == popularity_type_id:
                candidates.append(path)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            continue
    if not candidates:
        raise FileNotFoundError(
            f"No snapshot for popularity type {popularity_type_id} in {input_dir}"
        )
    return sorted(candidates)[-1]


def join_snapshots(
    snapshots: dict[int, dict[str, Any]],
) -> list[dict[str, Any]]:
    joined: dict[int, dict[str, Any]] = {}
    for popularity_type_id, snapshot in snapshots.items():
        prefix = DEFAULT_TYPES[popularity_type_id]
        for row in snapshot["rows"]:
            game_id = row.get("igdbGameId")
            if game_id is None:
                continue
            game_id = int(game_id)
            output = joined.setdefault(
                game_id,
                {
                    "igdb_game_id": game_id,
                    "name": row.get("name") or "",
                    "first_release_date": row.get("firstReleaseDate"),
                    "cover_url": row.get("coverUrl") or "",
                },
            )
            if not output["name"] and row.get("name"):
                output["name"] = row["name"]
            output[f"{prefix}_rank"] = row.get("rank")
            output[f"{prefix}_popscore"] = row.get("value")
    return sorted(
        joined.values(),
        key=lambda row: (
            -sum(
                1
                for popularity_type_id in DEFAULT_TYPES
                if f"{DEFAULT_TYPES[popularity_type_id]}_rank" in row
            ),
            row.get("name") or "",
            row["igdb_game_id"],
        ),
    )


FIELDNAMES = [
    "igdb_game_id",
    "name",
    "first_release_date",
    "cover_url",
    "played_rank",
    "played_popscore",
    "playing_rank",
    "playing_popscore",
    "peak_players_rank",
    "peak_players_popscore",
    "total_reviews_rank",
    "total_reviews_popscore",
]


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows({field: row.get(field, "") for field in FIELDNAMES} for row in rows)
    temporary.replace(path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Join IGDB popularity rankings into one CSV."
    )
    parser.add_argument("--input-dir", type=Path, default=DEFAULT_INPUT_DIR)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--limit", type=int, default=100)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.limit < 1:
        raise SystemExit("--limit must be positive")
    snapshots = {
        popularity_type_id: load_snapshot(
            find_snapshot(args.input_dir, popularity_type_id),
            args.limit,
        )
        for popularity_type_id in DEFAULT_TYPES
    }
    rows = join_snapshots(snapshots)
    write_csv(args.out, rows)
    print(
        f"types={len(snapshots)} topN={args.limit} rows={len(rows)} out={args.out}",
        flush=True,
    )


if __name__ == "__main__":
    main()
