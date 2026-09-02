#!/usr/bin/env python3
"""Compare IGDB popularity snapshots without touching the catalog database.

The fetcher deliberately stores one snapshot per popularity type.  This tool
turns those snapshots into a compact comparison report so we can decide which
signals are useful for SteamGuess before designing a database integration.

Name matching against SteamSpy is intentionally conservative: it is a
case-folded, Unicode-normalized, punctuation-insensitive comparison only.  It
is a coverage estimate, not the final IGDB-to-Steam mapping.  IGDB's
``external_games`` relation should be used for a production join.
"""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


DEFAULT_IGDB_DIR = Path("data/analysis/igdb-popularity-top500")
DEFAULT_STEAMSPY = Path("data/analysis/steamspy_weighted_top_2000.json")
DEFAULT_JSON_OUT = Path("data/analysis/igdb-popularity-comparison.json")
DEFAULT_MD_OUT = Path("data/analysis/igdb-popularity-comparison.md")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def normalized_name(value: str) -> str:
    """Return a stable conservative key for human-readable name comparison."""
    value = unicodedata.normalize("NFKC", value).casefold()
    return re.sub(r"[^\w]+", "", value, flags=re.UNICODE)


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_steamspy_names(path: Path) -> dict[str, dict[str, Any]]:
    payload = load_json(path)
    rows = payload.get("rows") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise ValueError(f"{path} does not contain a ranking payload with rows")
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        name = str(row.get("name") or "").strip()
        if name and normalized_name(name):
            result.setdefault(normalized_name(name), row)
    return result


def load_snapshots(directory: Path) -> list[dict[str, Any]]:
    snapshots: list[dict[str, Any]] = []
    for path in sorted(directory.glob("*.json")):
        payload = load_json(path)
        if not isinstance(payload, dict):
            continue
        popularity_type = payload.get("popularityType")
        rows = payload.get("rows")
        if not isinstance(popularity_type, dict) or not isinstance(rows, list):
            continue
        clean_rows = [row for row in rows if isinstance(row, dict)]
        snapshots.append(
            {
                "path": str(path),
                "id": int(popularity_type.get("id")),
                "name": str(popularity_type.get("name") or ""),
                "rows": clean_rows,
            }
        )
    if not snapshots:
        raise ValueError(f"No IGDB popularity snapshots found in {directory}")
    return sorted(snapshots, key=lambda item: item["id"])


def top_names(rows: Iterable[dict[str, Any]]) -> set[str]:
    return {
        normalized_name(str(row.get("name") or ""))
        for row in rows
        if str(row.get("name") or "").strip()
    }


def jaccard(left: set[str], right: set[str]) -> float:
    union = left | right
    return len(left & right) / len(union) if union else 1.0


def summarize_snapshot(
    snapshot: dict[str, Any],
    steamspy_names: dict[str, dict[str, Any]],
    limit: int,
) -> dict[str, Any]:
    rows = snapshot["rows"][:limit]
    names = top_names(rows)
    matches = [
        {
            "rank": row.get("rank"),
            "igdbGameId": row.get("igdbGameId"),
            "igdbName": row.get("name"),
            "steamSpyAppId": steamspy_names[normalized_name(str(row["name"]))].get(
                "appId"
            ),
            "steamSpyName": steamspy_names[normalized_name(str(row["name"]))].get(
                "name"
            ),
            "value": row.get("value"),
        }
        for row in rows
        if normalized_name(str(row.get("name") or "")) in steamspy_names
    ]
    values = [
        float(row["value"])
        for row in rows
        if isinstance(row.get("value"), (int, float))
    ]
    return {
        "id": snapshot["id"],
        "name": snapshot["name"],
        "path": snapshot["path"],
        "rows": len(rows),
        "distinctNames": len(names),
        "value": {
            "top": values[0] if values else None,
            "bottom": values[-1] if values else None,
            "min": min(values) if values else None,
            "max": max(values) if values else None,
        },
        "steamSpyExactNameMatches": len(matches),
        "steamSpyExactNameCoverage": len(matches) / len(rows) if rows else 0.0,
        "matches": matches,
        "top10": [
            {
                "rank": row.get("rank"),
                "name": row.get("name"),
                "igdbGameId": row.get("igdbGameId"),
                "value": row.get("value"),
            }
            for row in rows[:10]
        ],
        "_nameSet": names,
    }


def build_report(
    snapshots: list[dict[str, Any]],
    steamspy_names: dict[str, dict[str, Any]],
    limit: int,
    *,
    igdb_directory: Path = DEFAULT_IGDB_DIR,
    steamspy_path: Path = DEFAULT_STEAMSPY,
) -> dict[str, Any]:
    summaries = [
        summarize_snapshot(snapshot, steamspy_names, limit)
        for snapshot in snapshots
    ]
    pairwise: list[dict[str, Any]] = []
    for index, left in enumerate(summaries):
        for right in summaries[index + 1 :]:
            pairwise.append(
                {
                    "left": left["name"],
                    "right": right["name"],
                    "jaccard": jaccard(left["_nameSet"], right["_nameSet"]),
                    "intersection": len(left["_nameSet"] & right["_nameSet"]),
                }
            )
    for summary in summaries:
        summary.pop("_nameSet", None)
    return {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "matching": {
            "method": "NFKC + casefold + Unicode word characters; conservative name match",
            "warning": "Exact-name coverage is only a lower bound until IGDB external_games Steam IDs are joined.",
        },
        "input": {
            "igdbDirectory": str(igdb_directory),
            "steamSpyRanking": str(steamspy_path),
            "topNCompared": limit,
            "steamSpyRows": len(steamspy_names),
        },
        "types": summaries,
        "pairwise": pairwise,
    }


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def markdown_report(payload: dict[str, Any]) -> str:
    lines = [
        "# IGDB Popularity comparison",
        "",
        f"> Generated at `{payload['generatedAt']}`.",
        "",
        "This is an analysis snapshot only. It does not modify SQLite or the weekly catalog.",
        "SteamSpy coverage below uses conservative normalized-name matching; it is not the final AppID join.",
        "",
        "## Summary",
        "",
        "| Type | Compared | Top PopScore value | Bottom PopScore value | SteamSpy exact-name matches | Coverage |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for item in payload["types"]:
        value = item["value"]
        lines.append(
            f"| {item['id']} {item['name']} | {item['rows']} | "
            f"{value['top']:.8f} | {value['bottom']:.8f} | "
            f"{item['steamSpyExactNameMatches']} | "
            f"{item['steamSpyExactNameCoverage']:.1%} |"
        )
    lines.extend(["", "## Top 10 samples", ""])
    for item in payload["types"]:
        lines.extend([f"### {item['id']}. {item['name']}", "", "| Rank | Name | IGDB game ID | Value |", "|---:|---|---:|---:|"])
        for row in item["top10"]:
            lines.append(
                f"| {row['rank']} | {row['name'] or '—'} | "
                f"{row['igdbGameId']} | {row['value']:.8f} |"
            )
        lines.append("")
    lines.extend(
        [
            "## Interpretation",
            "",
            "- `Played` and `Total Reviews` are historical recognition/coverage signals.",
            "- `Playing` and `24hr Peak Players` are current activity signals.",
            "- `Want to Play` and `Most Wishlisted Upcoming` are future-interest signals.",
            "- `Global Top Sellers` is a commercial-trend signal and can include DLC, editions, and upcoming products.",
            "- `Visits` is volatile and should not be treated as a stable game-pool ranking by itself.",
            "- `value` is a dimensionless IGDB PopScore value, not a raw count or percentage.",
            "",
            "A production integration should join IGDB games to Steam AppIDs through IGDB's external-game relation, not game names.",
        ]
    )
    return "\n".join(lines) + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare saved IGDB popularity snapshots before database integration."
    )
    parser.add_argument("--igdb-dir", type=Path, default=DEFAULT_IGDB_DIR)
    parser.add_argument("--steamspy", type=Path, default=DEFAULT_STEAMSPY)
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--json-out", type=Path, default=DEFAULT_JSON_OUT)
    parser.add_argument("--md-out", type=Path, default=DEFAULT_MD_OUT)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.limit < 1:
        raise SystemExit("--limit must be positive")
    snapshots = load_snapshots(args.igdb_dir)
    steamspy_names = load_steamspy_names(args.steamspy)
    report = build_report(
        snapshots,
        steamspy_names,
        args.limit,
        igdb_directory=args.igdb_dir,
        steamspy_path=args.steamspy,
    )
    write_json(args.json_out, report)
    args.md_out.parent.mkdir(parents=True, exist_ok=True)
    args.md_out.write_text(markdown_report(report), encoding="utf-8")
    print(
        f"types={len(report['types'])} compared={args.limit} "
        f"json={args.json_out} markdown={args.md_out}",
        flush=True,
    )


if __name__ == "__main__":
    main()
