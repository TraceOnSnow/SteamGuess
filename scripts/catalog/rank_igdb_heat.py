#!/usr/bin/env python3
"""Rank an experimental IGDB heat score from popularity snapshots.

This is intentionally an analysis tool. It does not modify the SteamGuess
catalog database. It combines five IGDB PopScore primitives:

    0.1250 * Total Reviews
  + 0.3125 * IGDB Played
  + 0.3125 * IGDB Playing
  + 0.1250 * Steam 24hr Peak Players
  + 0.1250 * IGDB Visits

The input directory should contain one JSON snapshot per popularity type,
created by ``fetch_igdb_popularity.py``. The expected input is the union of
the top 3000 rows for each metric. The ranking accepts only games with all
five metrics, plus games whose only missing metrics are both Steam-derived
primitives. Missing Steam weights are renormalized over the three IGDB
metrics. Rows missing any IGDB metric, or only one Steam metric, are
discarded.
"""

from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_INPUT_DIR = Path("data/analysis/igdb-popularity-top3000")
DEFAULT_OUTPUT = Path("data/analysis/igdb-heat-all.json")

METRICS: dict[str, tuple[str, float]] = {
    # Original five-metric weights renormalized after removing Twitch.
    "Total Reviews": ("steam_total_reviews", 0.1250),
    "Played": ("igdb_played", 0.3125),
    "Playing": ("igdb_playing", 0.3125),
    "24hr Peak Players": ("steam_24hr_peak", 0.1250),
    "Visits": ("igdb_visits", 0.1250),
}

STEAM_FIELDS = frozenset({"steam_total_reviews", "steam_24hr_peak"})


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_snapshot(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} is not a JSON object")
    popularity_type = payload.get("popularityType")
    rows = payload.get("rows")
    if not isinstance(popularity_type, dict) or not isinstance(rows, list):
        raise ValueError(f"{path} is not an IGDB popularity snapshot")
    return payload


def find_snapshots(input_dir: Path) -> dict[str, tuple[Path, dict[str, Any]]]:
    found: dict[str, tuple[Path, dict[str, Any]]] = {}
    for path in sorted(input_dir.glob("*.json")):
        try:
            payload = load_snapshot(path)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            continue
        name = str(payload["popularityType"].get("name") or "").strip()
        if name in METRICS:
            found[name] = (path, payload)
    return found


def numeric(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def rank_rows(
    snapshots: dict[str, tuple[Path, dict[str, Any]]],
    *,
    limit: int,
) -> list[dict[str, Any]]:
    available_weight = sum(
        weight for name, (_, weight) in METRICS.items() if name in snapshots
    )
    if available_weight <= 0:
        raise ValueError("No configured popularity metrics are available")

    joined: dict[int, dict[str, Any]] = {}
    for metric_name, (_, payload) in snapshots.items():
        field, _ = METRICS[metric_name]
        rows = payload.get("rows", [])
        for row in rows:
            if not isinstance(row, dict) or row.get("igdbGameId") is None:
                continue
            game_id = int(row["igdbGameId"])
            output = joined.setdefault(
                game_id,
                {
                    "igdbGameId": game_id,
                    "name": str(row.get("name") or ""),
                },
            )
            if not output["name"] and row.get("name"):
                output["name"] = str(row["name"])
            output[field] = numeric(row.get("value"))
            output[f"{field}Rank"] = row.get("rank")

    for row in joined.values():
        score = 0.0
        metric_count = 0
        available_weight_for_row = 0.0
        missing_metrics: list[str] = []
        for metric_name, (field, weight) in METRICS.items():
            if metric_name not in snapshots:
                missing_metrics.append(field)
                continue
            if field not in row:
                missing_metrics.append(field)
                continue
            value = numeric(row.get(field))
            if row.get(field) is not None:
                metric_count += 1
                available_weight_for_row += weight
                score += weight * value
        # Missing metrics are unavailable observations, not zeroes. Their
        # weights are redistributed only across metrics actually present for
        # this game. Only rows missing exactly both Steam-derived metrics are
        # eligible below.
        if available_weight_for_row > 0:
            score /= available_weight_for_row
        row["metricCount"] = metric_count
        row["missingMetrics"] = missing_metrics
        missing_steam_fields = STEAM_FIELDS.intersection(missing_metrics)
        row["steamCoverage"] = (
            "available"
            if not missing_steam_fields
            else "not_available"
            if len(missing_steam_fields) == len(STEAM_FIELDS)
            else "partial"
        )
        row["availabilityClass"] = (
            "complete"
            if metric_count == len(METRICS)
            else "partial"
        )
        row["heatScore"] = round(score, 12)

    eligible_rows = [
        row
        for row in joined.values()
        if not row["missingMetrics"]
        or set(row["missingMetrics"]) == STEAM_FIELDS
    ]
    ranked = sorted(
        eligible_rows,
        key=lambda row: (
            -row["heatScore"],
            # Coverage is only a deterministic tie-breaker. It must not
            # override a materially higher score from a partial row.
            -row["metricCount"],
            row["name"].casefold(),
            row["igdbGameId"],
        ),
    )
    output_rows = ranked if limit <= 0 else ranked[:limit]
    for rank, row in enumerate(output_rows, start=1):
        row["rank"] = rank
    return output_rows


def write_json(
    path: Path,
    rows: list[dict[str, Any]],
    snapshots: dict[str, tuple[Path, dict[str, Any]]],
    requested_limit: int,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    available_weight = sum(
        weight for name, (_, weight) in METRICS.items() if name in snapshots
    )
    payload = {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "formula": {
            "normalization": "none; raw IGDB PopScore values as returned",
            "weights": {
                field: weight for _, (field, weight) in METRICS.items()
            },
            "availableWeightTotal": available_weight,
            "effectiveWeights": {
                field: round(weight / available_weight, 8)
                for name, (field, weight) in METRICS.items()
                if name in snapshots
            },
            "missingMetric": "per_row_missing_metrics_renormalized",
            "rowEligibility": (
                "all_five_metrics_or_only_both_steam_metrics_missing"
            ),
            "missingConfiguredMetrics": sorted(set(METRICS) - set(snapshots)),
        },
        "input": {
            "directory": str(path.parent),
            "requestedLimit": requested_limit,
            "unionRows": len({
                int(row["igdbGameId"])
                for _, payload in snapshots.values()
                for row in payload.get("rows", [])
                if isinstance(row, dict) and row.get("igdbGameId") is not None
            }),
            "snapshots": {
                name: {
                    "path": str(snapshot_path),
                    "rows": len(payload.get("rows", [])),
                    "popularityType": payload.get("popularityType"),
                }
                for name, (snapshot_path, payload) in snapshots.items()
            },
        },
        "rows": rows,
    }
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


CSV_FIELDS = [
    "rank",
    "igdbGameId",
    "name",
    "heatScore",
    "metricCount",
    "steam_total_reviews",
    "igdb_played",
    "igdb_playing",
    "steam_24hr_peak",
    "igdb_visits",
]


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(
            {field: row.get(field, "") for field in CSV_FIELDS} for row in rows
        )
    temporary.replace(path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Rank an experimental IGDB heat score from snapshots."
    )
    parser.add_argument("--input-dir", type=Path, default=DEFAULT_INPUT_DIR)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--csv-out",
        type=Path,
        default=None,
        help="CSV output; defaults to the JSON path with a .csv suffix",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Maximum output rows; 0 outputs the complete union (default).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.limit < 0:
        raise SystemExit("--limit must be zero or positive")
    snapshots = find_snapshots(args.input_dir)
    missing = sorted(set(METRICS) - set(snapshots))
    if missing:
        print(
            "warning: missing popularity snapshots (weights renormalized): "
            + ", ".join(missing),
            flush=True,
        )
    rows = rank_rows(snapshots, limit=args.limit)
    write_json(args.out, rows, snapshots, args.limit)
    csv_path = args.csv_out or args.out.with_suffix(".csv")
    write_csv(csv_path, rows)
    print(f"ranked={len(rows)} json={args.out} csv={csv_path}")


if __name__ == "__main__":
    main()
