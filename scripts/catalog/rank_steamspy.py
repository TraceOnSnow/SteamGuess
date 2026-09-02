#!/usr/bin/env python3
"""Rank the complete available SteamSpy raw pool with weighted log-normalized metrics.

This is an analysis tool, not part of the weekly publication pipeline. It reads
all available ``request=all`` raw page checkpoints, chooses the newest file for
each page, and ranks the combined pool:

    score = 100 * (0.85 * normalized(log1p(total_reviews))
                   + 0.15 * normalized(log1p(ccu)))

Normalization is min-max normalization across the complete input pool before
the Top N cutoff is applied. The output intentionally keeps the original
SteamSpy values so the ranking is easy to inspect.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from math import log1p
from pathlib import Path
from typing import Any, Iterable

from scripts.catalog.discover_steamspy import as_int

PAGE_FILE_RE = re.compile(r"^page_(\d+)_.*\.json$")
DEFAULT_RAW_DIR = Path("data/raw/steamspy")
DEFAULT_OUTPUT = Path("data/analysis/steamspy_weighted_top_2000.json")


@dataclass(frozen=True)
class RawPage:
    page: int
    path: Path
    retrieved_at: str
    payload: dict[str, Any]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def raw_page_number(path: Path) -> int | None:
    match = PAGE_FILE_RE.match(path.name)
    return int(match.group(1)) if match else None


def timestamp_key(page: RawPage) -> tuple[str, float, str]:
    """Sort by envelope timestamp, then parsed timestamp, then path."""
    try:
        retrieved = datetime.fromisoformat(
            page.retrieved_at.replace("Z", "+00:00")
        ).timestamp()
    except (TypeError, ValueError, OverflowError):
        retrieved = 0.0
    return (page.retrieved_at, retrieved, str(page.path))


def load_raw_page(path: Path) -> RawPage:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} is not a JSON object")

    page = raw_page_number(path)
    if page is None:
        raise ValueError(f"{path} does not match page_<number>_*.json")

    raw_payload = payload.get("payload")
    if not isinstance(raw_payload, dict):
        raise ValueError(f"{path} has no object payload")

    return RawPage(
        page=page,
        path=path,
        retrieved_at=str(payload.get("retrievedAt") or ""),
        payload=raw_payload,
    )


def select_latest_pages(raw_dir: Path) -> list[RawPage]:
    """Select the newest raw checkpoint independently for each page number."""
    selected: dict[int, RawPage] = {}
    for path in raw_dir.glob("page_*.json"):
        if raw_page_number(path) is None:
            continue
        page = load_raw_page(path)
        previous = selected.get(page.page)
        if previous is None or timestamp_key(page) > timestamp_key(previous):
            selected[page.page] = page
    return [selected[number] for number in sorted(selected)]


def normalize_metric(value: float, minimum: float, maximum: float) -> float:
    if maximum <= minimum:
        return 0.0
    return (value - minimum) / (maximum - minimum)


def total_reviews(row: dict[str, Any]) -> int:
    return as_int(row.get("positive")) + as_int(row.get("negative"))


def iter_rows(pages: Iterable[RawPage]) -> Iterable[dict[str, Any]]:
    seen: set[int] = set()
    for page in pages:
        for key, raw in page.payload.items():
            if not isinstance(raw, dict):
                continue
            appid = as_int(raw.get("appid") or key)
            name = str(raw.get("name") or "").strip()
            if not appid or not name or appid in seen:
                continue
            seen.add(appid)
            yield {
                "appId": appid,
                "name": name,
                "page": page.page,
                "rawFile": str(page.path),
                "retrievedAt": page.retrieved_at,
                "commentCount": total_reviews(raw),
                "positive": as_int(raw.get("positive")),
                "negative": as_int(raw.get("negative")),
                "ccu": as_int(raw.get("ccu")),
                "owners": str(raw.get("owners") or ""),
                "scoreRank": str(raw.get("score_rank") or ""),
            }


def rank_rows(
    rows: list[dict[str, Any]],
    comments_weight: float = 0.85,
    ccu_weight: float = 0.15,
) -> list[dict[str, Any]]:
    if not rows:
        return []
    if comments_weight < 0 or ccu_weight < 0 or comments_weight + ccu_weight <= 0:
        raise ValueError("Weights must be non-negative and have a positive total")

    weight_total = comments_weight + ccu_weight
    comments_weight /= weight_total
    ccu_weight /= weight_total

    comment_logs = [log1p(row["commentCount"]) for row in rows]
    ccu_logs = [log1p(row["ccu"]) for row in rows]
    comment_min, comment_max = min(comment_logs), max(comment_logs)
    ccu_min, ccu_max = min(ccu_logs), max(ccu_logs)

    ranked = []
    for row, comment_log, ccu_log in zip(rows, comment_logs, ccu_logs):
        normalized_comments = normalize_metric(comment_log, comment_min, comment_max)
        normalized_ccu = normalize_metric(ccu_log, ccu_min, ccu_max)
        score = 100.0 * (
            comments_weight * normalized_comments
            + ccu_weight * normalized_ccu
        )
        ranked.append({
            **row,
            "logComments": round(comment_log, 6),
            "logCcu": round(ccu_log, 6),
            "normalizedComments": round(normalized_comments, 6),
            "normalizedCcu": round(normalized_ccu, 6),
            "score": round(score, 4),
        })

    # Stable tie-breakers make repeated analysis reproducible.
    ranked.sort(
        key=lambda row: (
            -row["score"],
            -row["commentCount"],
            -row["ccu"],
            row["page"],
            row["appId"],
        )
    )
    for rank, row in enumerate(ranked, start=1):
        row["rank"] = rank
    return ranked


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


CSV_FIELDS = (
    "rank",
    "appId",
    "name",
    "score",
    "commentCount",
    "ccu",
    "positive",
    "negative",
    "normalizedComments",
    "normalizedCcu",
    "page",
    "retrievedAt",
)


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(
            {field: row.get(field) for field in CSV_FIELDS} for row in rows
        )
    temporary.replace(path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Rank all available SteamSpy request=all raw pages by weighted "
            "log-normalized metrics."
        )
    )
    parser.add_argument("--raw-dir", type=Path, default=DEFAULT_RAW_DIR)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--csv-out",
        type=Path,
        default=None,
        help="CSV output path; defaults to the JSON path with a .csv suffix",
    )
    parser.add_argument("--limit", type=int, default=2000)
    parser.add_argument("--comments-weight", type=float, default=0.85)
    parser.add_argument("--ccu-weight", type=float, default=0.15)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.limit < 1:
        raise SystemExit("--limit must be positive")

    pages = select_latest_pages(args.raw_dir)
    if not pages:
        raise SystemExit(f"No SteamSpy raw page files found in {args.raw_dir}")

    all_rows = rank_rows(
        list(iter_rows(pages)),
        comments_weight=args.comments_weight,
        ccu_weight=args.ccu_weight,
    )
    selected = all_rows[:args.limit]
    csv_path = args.csv_out or args.out.with_suffix(".csv")
    weight_total = args.comments_weight + args.ccu_weight
    payload = {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "formula": {
            "commentsWeight": args.comments_weight / weight_total,
            "ccuWeight": args.ccu_weight / weight_total,
            "normalization": (
                "min-max over log1p(metric) across all deduplicated raw rows"
            ),
            "commentMetric": "positive + negative",
        },
        "input": {
            "rawDir": str(args.raw_dir),
            "pages": [page.page for page in pages],
            "rawRows": sum(len(page.payload) for page in pages),
            "deduplicatedRows": len(all_rows),
            "selectedRows": len(selected),
            "selectedRawFiles": [str(page.path) for page in pages],
        },
        "rows": selected,
    }
    write_json(args.out, payload)
    write_csv(csv_path, selected)
    print(
        f"pages={len(pages)} raw_rows={payload['input']['rawRows']} "
        f"deduplicated={len(all_rows)} selected={len(selected)} "
        f"json={args.out} csv={csv_path}",
        flush=True,
    )
    for row in selected[:10]:
        print(
            f"{row['rank']:>4} {row['score']:>7.2f} "
            f"comments={row['commentCount']:>9} ccu={row['ccu']:>8} "
            f"{row['name']}",
            flush=True,
        )


if __name__ == "__main__":
    main()
