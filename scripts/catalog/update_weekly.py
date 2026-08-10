#!/usr/bin/env python3
"""Incremental weekly catalog update planner and orchestrator.

The command is safe to run with --plan-only first. Network enrichment is only
performed for active apps whose corresponding job is not complete.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from scripts.catalog.database import connect, initialize

@dataclass(frozen=True)
class UpdatePlan:
    catalog_appids: tuple[int, ...]
    active_appids: tuple[int, ...]
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

def restore_cached_pics(catalog_path: Path, db_path: Path) -> int:
    """Materialize completed PICS metadata back into the normalized catalog.

    SteamSpy discovery deliberately creates a fresh row with ``tags=[]``.
    PICS is not fetched every week, so the persistent catalog DB is the
    authoritative cache and must be merged before publishing or planning.
    """
    if not db_path.exists():
        return 0
    payload = json.loads(catalog_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("games"), list):
        return 0
    connection = connect(db_path)
    try:
        initialize(connection)
        app_rows = connection.execute(
            "SELECT appid, app_type, pics_change_number FROM apps"
        ).fetchall()
        tag_rows = connection.execute(
            """
            SELECT appid, position, tag_id, name, retrieved_at
            FROM app_tags
            WHERE source = 'pics'
            ORDER BY appid, position
            """
        ).fetchall()
    finally:
        connection.close()

    app_meta = {int(row["appid"]): row for row in app_rows}
    tags_by_app: dict[int, list[dict[str, Any]]] = {}
    retrieved_by_app: dict[int, str] = {}
    for row in tag_rows:
        appid = int(row["appid"])
        tags_by_app.setdefault(appid, []).append({
            "id": row["tag_id"],
            "rank": int(row["position"]) + 1,
            "name": str(row["name"]),
        })
        if row["retrieved_at"]:
            retrieved_by_app[appid] = str(row["retrieved_at"])

    restored = 0
    for game in payload["games"]:
        appid = int(game["appId"])
        cached_tags = tags_by_app.get(appid)
        if not cached_tags and appid not in app_meta:
            continue
        changed = False
        if cached_tags and not game.get("tags"):
            game["tags"] = cached_tags[:20]
            game.setdefault("fieldSources", {})["tags"] = "pics"
            game.setdefault("sources", []).append({
                "service": "pics",
                "endpoint": "SQLite cache",
                "retrievedAt": retrieved_by_app.get(appid),
            })
            changed = True
        if cached_tags and game.setdefault("fieldSources", {}).get("tags") == "pics:sqlite-cache":
            game["fieldSources"]["tags"] = "pics"
            changed = True
        row = app_meta.get(appid)
        if row:
            if not game.get("type") and row["app_type"]:
                game["type"] = row["app_type"]
                game.setdefault("fieldSources", {})["type"] = "pics"
                changed = True
            if game.setdefault("fieldSources", {}).get("type") == "pics:sqlite-cache":
                game["fieldSources"]["type"] = "pics"
                changed = True
            if not game.get("picsChangeNumber") and row["pics_change_number"]:
                game["picsChangeNumber"] = row["pics_change_number"]
                changed = True
        restored += int(changed)

    if restored:
        catalog_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return restored


def build_plan(db_path: Path, catalog_path: Path, active_limit: int = 6000) -> UpdatePlan:
    games = load_games(catalog_path)
    active = games[:max(0, active_limit)]
    active_ids = tuple(int(game["appId"]) for game in active)
    reserve_ids = tuple(int(game["appId"]) for game in games[max(0, active_limit):])
    connection = connect(db_path)
    try:
        initialize(connection)
        rows = connection.execute("SELECT appid, service, locale, country, status FROM enrichment_jobs").fetchall()
        jobs = {(int(row["appid"]), row["service"], row["locale"], row["country"]): row["status"] for row in rows}
        known_active = {int(row["appid"]) for row in connection.execute("SELECT appid FROM catalog_memberships WHERE catalog = 'active'")}
    finally:
        connection.close()
    new_active = tuple(appid for appid in active_ids if appid not in known_active)
    missing_pics = tuple(appid for appid in active_ids if jobs.get((appid, "pics", "", "")) != "complete")
    active_by_id = {int(game["appId"]): game for game in active}
    missing_storefront = tuple(
        appid for appid in active_ids
        if jobs.get((appid, "storefront", "schinese", "cn")) != "complete"
        or not storefront_fields_complete(active_by_id[appid])
    )
    missing_reviews = tuple(appid for appid in active_ids if any(jobs.get((appid, "reviews", language, "")) != "complete" for language in ("english", "schinese")))
    return UpdatePlan(tuple(int(game["appId"]) for game in games), active_ids, reserve_ids, new_active, missing_pics, missing_storefront, missing_reviews)

def write_appids(path: Path, appids: tuple[int, ...]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"appIds": list(appids)}, indent=2) + "\n", encoding="utf-8")

def run(command: list[str]) -> None:
    print("$ " + " ".join(command), flush=True)
    subprocess.run(command, check=True)

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", type=Path, default=Path("data/catalog/steamspy_candidates.json"))
    parser.add_argument("--db", type=Path, default=Path("data/catalog/catalog.sqlite"))
    parser.add_argument("--playable", type=Path, default=Path("public/games_demo.json"))
    parser.add_argument("--labeling", type=Path, default=Path("public/labeling_catalog.json"))
    parser.add_argument("--active-limit", type=int, default=6000)
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
    parser.add_argument("--plan-only", action="store_true")
    parser.add_argument("--from-existing-catalog", action="store_true")
    parser.add_argument("--skip-enrichment", action="store_true")
    args = parser.parse_args()
    if args.active_limit < 1:
        raise SystemExit("--active-limit must be positive")
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
    plan = build_plan(args.db, args.catalog, args.active_limit)
    print(json.dumps({
        "catalog": len(plan.catalog_appids), "active": len(plan.active_appids), "reserve": len(plan.reserve_appids),
        "newActive": len(plan.new_active_appids), "missingPics": len(plan.missing_pics),
        "missingStorefront": len(plan.missing_storefront), "missingReviews": len(plan.missing_reviews),
    }, indent=2))
    if args.plan_only:
        return
    if args.pics:
        run([sys.executable, "-m", "scripts.catalog.enrich_pics", "--catalog", str(args.catalog), "--pics", str(args.pics), "--out", str(args.catalog)])
    if not args.skip_enrichment:
        appids_path = args.catalog.with_name("weekly_active_appids.json")
        write_appids(appids_path, plan.missing_storefront)
        if plan.missing_storefront:
            run([sys.executable, "-m", "scripts.catalog.enrich_storefront", "--catalog", str(args.catalog), "--appids-from", str(appids_path), "--out", str(args.catalog), "--state", str(args.storefront_state), "--delay", str(args.storefront_delay)])
        write_appids(appids_path, plan.missing_reviews)
        if plan.missing_reviews:
            run([sys.executable, "-m", "scripts.catalog.enrich_reviews", "--catalog", str(args.catalog), "--appids", str(appids_path), "--out", str(args.catalog), "--delay", str(args.reviews_delay),
                   "--retries", str(args.reviews_retries), "--retry-delay", str(args.reviews_retry_delay)])
    # Export first so import_current can derive search/playable membership from
    # the same catalog snapshot rather than one-week-old public data.
    run([sys.executable, "-m", "scripts.catalog.publish_playable", "--catalog", str(args.catalog), "--db", str(args.db), "--playable", str(args.playable), "--out", str(args.playable), "--active-limit", str(args.active_limit)])
    run([sys.executable, "-m", "scripts.catalog.publish_labeling", "--catalog", str(args.catalog), "--demo", str(args.playable), "--out", str(args.labeling), "--active-limit", str(args.active_limit)])
    run([sys.executable, "-m", "scripts.catalog.import_current", "--db", str(args.db), "--catalog", str(args.catalog), "--playable", str(args.playable), "--labeling", str(args.labeling), "--active-limit", str(args.active_limit)])
    run([sys.executable, "-m", "scripts.catalog.status", "--db", str(args.db)])

if __name__ == "__main__":
    main()
