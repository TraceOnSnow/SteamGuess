#!/usr/bin/env python3
"""Incremental weekly catalog update planner and orchestrator.

The command is safe to run with --plan-only first. Network enrichment is only
performed for detail-window apps whose corresponding job is not complete.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from scripts.catalog.database import catalog_exclusion_ids, connect, initialize, json_load, partition_catalog_rows

REVIEWS_PER_LANGUAGE = 100

@dataclass(frozen=True)
class UpdatePlan:
    catalog_appids: tuple[int, ...]
    active_appids: tuple[int, ...]
    detail_appids: tuple[int, ...]
    reserve_appids: tuple[int, ...]
    new_active_appids: tuple[int, ...]
    missing_pics: tuple[int, ...]
    missing_storefront: tuple[int, ...]
    missing_reviews: tuple[int, ...]

def load_games(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    games = payload.get("games", []) if isinstance(payload, dict) else payload
    return [game for game in games if isinstance(game, dict) and game.get("appId")]


def storefront_fields_complete(game: dict[str, Any]) -> bool:
    """Return whether the current catalog row has enough Storefront identity data.

    Job rows survive catalog refreshes, so an old ``complete`` job must not hide
    fields that are absent from the current JSON snapshot. ``releaseDate`` and
    screenshots are intentionally optional: Steam can legitimately omit them.
    """
    localized = game.get("localizedNames")
    localized_name = localized.get("zh") if isinstance(localized, dict) else None
    prices = game.get("regionalPrices")
    cn_price = prices.get("cn") if isinstance(prices, dict) else None
    price_status = cn_price.get("status") if isinstance(cn_price, dict) else None
    return bool(
        str(game.get("type") or "").strip()
        and str(localized_name or "").strip()
        and price_status in {"available", "free", "unavailable"}
    )

def restore_cached_metadata(catalog_path: Path, db_path: Path) -> int:
    """Hydrate a fresh SteamSpy snapshot from the canonical one-row catalog.

    Discovery intentionally contains only the current ranking fields.  All
    expensive metadata already present in ``games`` is copied into the staged
    JSON before planning, so a weekly run only requests genuinely missing
    fields and never depends on legacy task tables.
    """
    if not db_path.exists():
        return 0
    payload = json.loads(catalog_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("games"), list):
        return 0
    connection = connect(db_path)
    try:
        initialize(connection)
        rows = connection.execute("SELECT * FROM games").fetchall()
    finally:
        connection.close()

    by_app = {int(row["appid"]): row for row in rows}

    restored = 0
    for game in payload["games"]:
        appid = int(game["appId"])
        row = by_app.get(appid)
        if row is None:
            continue
        changed = False
        def restore(field: str, value: Any, *, allow_empty: bool = False) -> None:
            nonlocal changed
            if value is None:
                return
            if not allow_empty and value in ("", [], {}, "[]", "{}"):
                return
            if game.get(field) in (None, "", [], {}):
                game[field] = value
                changed = True

        restore("type", row["app_type"])
        restore("picsChangeNumber", row["pics_change_number"])
        restore("releaseDate", row["release_date"])
        restore("headerImage", row["cover_url"])
        restore("localizedNames", {"zh": row["name_zh"]} if row["name_zh"] else {})
        restore("developers", json_load(row["developers_json"], []))
        restore("publishers", json_load(row["publishers_json"], []))
        restore("tags", json_load(row["tags_json"], []))
        restore("screenshots", [
            {"path": url} for url in json_load(row["screenshot_urls_json"], [])
        ])
        restore("regionalPrices", {
            country: {
                "currency": row[f"price_{country}_currency"],
                "status": row[f"price_{country}_status"],
                "regularCents": row[f"price_{country}_regular_cents"],
            }
            for country in ("us", "cn")
            if row[f"price_{country}_status"]
        })
        restore("metrics", json_load(row["steam_metrics_json"], {}))
        restore("reviews", {
            "english": json_load(row["reviews_en_json"], []),
            "schinese": json_load(row["reviews_zh_json"], []),
        })
        status = json_load(row["enrichment_status_json"], {})
        if isinstance(status, dict) and status.get("reviews"):
            restore("reviewFetchLimits", status["reviews"])
        if row["raw_pics_json"]:
            restore("rawPics", json_load(row["raw_pics_json"], {}))
        restored += int(changed)

    if restored:
        catalog_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return restored


# Kept as a small compatibility alias for local scripts that used the old
# function name.  It now restores every persisted metadata field, not only PICS.
restore_cached_pics = restore_cached_metadata


def build_plan(
    db_path: Path,
    catalog_path: Path,
    active_limit: int = 1000,
    detail_limit: int | None = None,
) -> UpdatePlan:
    games = load_games(catalog_path)
    detail_limit = active_limit if detail_limit is None else detail_limit
    connection = connect(db_path)
    try:
        initialize(connection)
        excluded_ids = catalog_exclusion_ids(connection)
        active, reserve, _excluded = partition_catalog_rows(
            games, excluded_ids, active_limit
        )
        detail, _outside_detail, _excluded = partition_catalog_rows(
            games, excluded_ids, detail_limit
        )
        active_ids = tuple(int(game["appId"]) for game in active)
        detail_ids = tuple(int(game["appId"]) for game in detail)
        reserve_ids = tuple(int(game["appId"]) for game in reserve)
        known_active = {
            int(row["appid"])
            for row in connection.execute(
                "SELECT appid FROM games WHERE pool_status = 'eligible'"
            )
        }
    finally:
        connection.close()
    new_active = tuple(appid for appid in active_ids if appid not in known_active)
    detail_by_id = {int(game["appId"]): game for game in detail}
    missing_pics = tuple(
        appid for appid in detail_ids
        if not detail_by_id[appid].get("tags")
        and not detail_by_id[appid].get("rawPics")
    )
    missing_storefront = tuple(
        appid for appid in detail_ids
        if not storefront_fields_complete(detail_by_id[appid])
    )
    missing_reviews = tuple(
        appid for appid in detail_ids
        if any(
            int(detail_by_id[appid].get("reviewFetchLimits", {}).get(language, 0) or 0) < REVIEWS_PER_LANGUAGE
            for language in ("english", "schinese")
        )
    )
    return UpdatePlan(
        tuple(int(game["appId"]) for game in games),
        active_ids,
        detail_ids,
        reserve_ids,
        new_active,
        missing_pics,
        missing_storefront,
        missing_reviews,
    )

def write_appids(path: Path, appids: tuple[int, ...]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"appIds": list(appids)}, indent=2) + "\n", encoding="utf-8")

def run(command: list[str]) -> None:
    print("$ " + " ".join(command), flush=True)
    subprocess.run(command, check=True)


def fetch_pics_checkpoints(
    appids: tuple[int, ...],
    catalog_path: Path,
    runner: Path,
    chunk_size: int,
    timeout: int,
) -> Path:
    """Fetch missing PICS rows in durable chunks and merge one import snapshot."""
    checkpoint_dir = catalog_path.with_name("pics-checkpoints")
    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    snapshots: list[dict[str, Any]] = []
    for offset in range(0, len(appids), chunk_size):
        chunk = appids[offset:offset + chunk_size]
        number = offset // chunk_size
        appids_path = checkpoint_dir / f"chunk-{number:04d}-appids.json"
        snapshot_path = checkpoint_dir / f"chunk-{number:04d}.json"
        write_appids(appids_path, chunk)
        reusable = False
        if snapshot_path.exists():
            try:
                existing = json.loads(snapshot_path.read_text(encoding="utf-8"))
                reusable = tuple(int(value) for value in existing.get("requestedAppIds", [])) == chunk
            except (json.JSONDecodeError, OSError, TypeError, ValueError):
                reusable = False
        if reusable:
            print(f"PICS chunk {number + 1} resumed from {snapshot_path}", flush=True)
        else:
            run([
                "node", str(runner),
                "--file", str(appids_path),
                "--out", str(snapshot_path),
                "--batch-size", "50",
                "--timeout", str(timeout),
                "--no-stdout",
            ])
        snapshots.append(json.loads(snapshot_path.read_text(encoding="utf-8")))

    merged = {
        "generatedAt": max(
            (str(snapshot.get("generatedAt") or "") for snapshot in snapshots),
            default="",
        ),
        "language": "english",
        "tagNameSource": "checkpoint-merge",
        "requestedAppIds": list(appids),
        "unknownAppIds": [
            value
            for snapshot in snapshots
            for value in snapshot.get("unknownAppIds", [])
        ],
        "games": {
            str(appid): game
            for snapshot in snapshots
            for appid, game in snapshot.get("games", {}).items()
        },
    }
    output = checkpoint_dir / "merged.json"
    output.write_text(json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return output

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", type=Path, default=Path("data/catalog/steamspy_candidates.json"))
    parser.add_argument("--db", type=Path, default=Path("data/catalog/catalog.sqlite"))
    parser.add_argument("--playable", type=Path, default=Path("public/games_demo.json"))
    parser.add_argument("--active-limit", type=int, default=1000)
    parser.add_argument("--detail-limit", type=int, default=4000)
    parser.add_argument("--pages", default=",".join(str(page) for page in range(20)))
    parser.add_argument("--interval", type=float, default=120.0, help="SteamSpy delay between pages")
    parser.add_argument("--steamspy-retries", type=int, default=2, help="Retries for each SteamSpy page")
    parser.add_argument("--steamspy-retry-delay", type=float, default=30.0, help="Base delay between SteamSpy retries")
    parser.add_argument("--storefront-delay", type=float, default=2.0, help="Delay between Storefront requests")
    parser.add_argument("--reviews-delay", type=float, default=2.0, help="Delay between review requests")
    parser.add_argument("--reviews-retries", type=int, default=3, help="Retries for transient review failures")
    parser.add_argument("--reviews-retry-delay", type=float, default=30.0, help="Delay between review retries")
    parser.add_argument("--storefront-state", type=Path, default=Path("data/processed/storefront_localized_names_schinese.json"))
    parser.add_argument("--raw-dir", type=Path, default=Path("data/raw/steamspy"))
    parser.add_argument("--resume-discovery", action="store_true")
    parser.add_argument("--pics", type=Path, help="Prepared PICS JSON; omitted means preserve existing PICS data")
    parser.add_argument("--auto-pics", action="store_true", help="Fetch missing PICS rows with the anonymous Steam client")
    parser.add_argument("--pics-runner", type=Path, default=Path("scripts/experimental/pics-poc/pics_tags_poc.mjs"))
    parser.add_argument("--pics-chunk-size", type=int, default=500)
    parser.add_argument("--pics-timeout", type=int, default=600, help="Timeout in seconds for each PICS checkpoint chunk")
    parser.add_argument("--plan-only", action="store_true")
    parser.add_argument("--from-existing-catalog", action="store_true")
    parser.add_argument("--skip-enrichment", action="store_true")
    args = parser.parse_args()
    if args.active_limit < 1:
        raise SystemExit("--active-limit must be positive")
    if args.detail_limit < args.active_limit:
        raise SystemExit("--detail-limit must be greater than or equal to --active-limit")
    if args.pics_chunk_size < 1 or args.pics_timeout < 1:
        raise SystemExit("PICS chunk size and timeout must be positive")
    if not args.from_existing_catalog:
        discovery = [sys.executable, "-m", "scripts.catalog.discover_steamspy", "--pages", args.pages,
                     "--interval", str(args.interval), "--retries", str(args.steamspy_retries),
                     "--retry-delay", str(args.steamspy_retry_delay), "--raw-dir", str(args.raw_dir), "--out", str(args.catalog)]
        if args.resume_discovery:
            discovery.append("--resume")
        run(discovery)
    restored = restore_cached_pics(args.catalog, args.db)
    if restored:
        print(f"restored_cached_pics={restored}", flush=True)
    plan = build_plan(args.db, args.catalog, args.active_limit, args.detail_limit)
    print(json.dumps({
        "catalog": len(plan.catalog_appids), "active": len(plan.active_appids),
        "detail": len(plan.detail_appids), "reserve": len(plan.reserve_appids),
        "newActive": len(plan.new_active_appids), "missingPics": len(plan.missing_pics),
        "missingStorefront": len(plan.missing_storefront), "missingReviews": len(plan.missing_reviews),
    }, indent=2))
    if args.plan_only:
        return
    pics_snapshot = args.pics
    if not args.skip_enrichment and not pics_snapshot and args.auto_pics and plan.missing_pics:
        if not args.pics_runner.exists():
            raise SystemExit(f"PICS runner not found: {args.pics_runner}")
        pics_snapshot = fetch_pics_checkpoints(
            plan.missing_pics,
            args.catalog,
            args.pics_runner,
            args.pics_chunk_size,
            args.pics_timeout,
        )
    if pics_snapshot:
        run([sys.executable, "-m", "scripts.catalog.enrich_pics", "--catalog", str(args.catalog), "--pics", str(pics_snapshot), "--out", str(args.catalog)])
    if not args.skip_enrichment:
        appids_path = args.catalog.with_name("weekly_active_appids.json")
        write_appids(appids_path, plan.missing_storefront)
        if plan.missing_storefront:
            run([sys.executable, "-m", "scripts.catalog.enrich_storefront", "--catalog", str(args.catalog), "--appids-from", str(appids_path), "--out", str(args.catalog), "--state", str(args.storefront_state), "--delay", str(args.storefront_delay)])
        write_appids(appids_path, plan.missing_reviews)
        if plan.missing_reviews:
            run([sys.executable, "-m", "scripts.catalog.enrich_reviews", "--catalog", str(args.catalog), "--appids", str(appids_path), "--out", str(args.catalog), "--delay", str(args.reviews_delay),
                   "--retries", str(args.reviews_retries), "--retry-delay", str(args.reviews_retry_delay)])
    # Import normalized source data before publishing so the browser snapshot
    # can materialize editorial difficulty, accepted feedback, and locks stored
    # in catalog SQLite. Weekly metadata imports never create or recompute
    # difficulty scores.
    run([sys.executable, "-m", "scripts.catalog.import_current", "--db", str(args.db), "--catalog", str(args.catalog), "--playable", str(args.playable), "--active-limit", str(args.active_limit)])
    run([sys.executable, "-m", "scripts.catalog.publish_playable", "--catalog", str(args.catalog), "--db", str(args.db), "--playable", str(args.playable), "--out", str(args.playable), "--active-limit", str(args.active_limit)])
    # Refresh Search/Playable memberships from the newly published snapshot.
    run([sys.executable, "-m", "scripts.catalog.import_current", "--db", str(args.db), "--catalog", str(args.catalog), "--playable", str(args.playable), "--active-limit", str(args.active_limit)])
    run([sys.executable, "-m", "scripts.catalog.status", "--db", str(args.db)])

if __name__ == "__main__":
    main()
