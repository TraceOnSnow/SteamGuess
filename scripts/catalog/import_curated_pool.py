#!/usr/bin/env python3
"""Import a loose, human-curated progressive pool into the catalog database.

The source list contains names rather than AppIDs. Matching is deliberately
conservative: exact normalized names, then exact names after removing common
Steam edition suffixes. Remaining rows are reported, never guessed silently.
The importer fills the requested pool sizes with existing catalog games whose
current heuristic level matches the missing bucket, preferring active games.
"""
from __future__ import annotations

import argparse
import json
import sys
import re
import sqlite3
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from scripts.catalog.database import connect, initialize, utc_now
except ModuleNotFoundError:  # support `python scripts/catalog/import_curated_pool.py`
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from scripts.catalog.database import connect, initialize, utc_now

TIERS = {1: "easy", 2: "normal", 3: "hard", 4: "hell"}
TARGET_EXCLUSIVE = {1: 75, 2: 125, 3: 125, 4: 275}
SUFFIXES = (
    " definitive edition", " ultimate edition", " goty edition", " game of the year edition",
    " complete edition", " enhanced plus edition", " enhanced edition", " final cut",
    " farewell edition", " gold classic", " gold edition", " classic", " edition",
)


def normalize(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).casefold()
    # NFKC turns ™ into the letters TM, so remove marks before and after it.
    text = re.sub(r"[™®©]", "", text)
    text = re.sub(r"\btm\b", "", text)
    text = text.replace("&", " and ")
    text = re.sub(r"[^\w]+", " ", text, flags=re.UNICODE)
    return " ".join(text.split())


def base_name(value: Any) -> str:
    text = normalize(value)
    changed = True
    while changed:
        changed = False
        for suffix in SUFFIXES:
            suffix = normalize(suffix)
            if text.endswith(suffix):
                text = text[: -len(suffix)].strip(" -:")
                changed = True
                break
    text = re.sub(r"\s+\d{4}$", "", text)
    return text.strip()


def load_games(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    games = payload.get("games") if isinstance(payload, dict) else payload
    if not isinstance(games, list):
        raise ValueError("Pool must contain a games array")
    return [game for game in games if isinstance(game, dict) and game.get("game")]


def choose(candidates: set[int], app_meta: dict[int, sqlite3.Row]) -> tuple[int | None, str]:
    if len(candidates) == 1:
        return next(iter(candidates)), "exact"
    # Prefer actual game records with release metadata; this resolves common
    # old/demo duplicate records without making a fuzzy title guess.
    ranked = sorted(candidates, key=lambda appid: (
        str(app_meta[appid]["app_type"] or "").lower() not in {"game"},
        app_meta[appid]["release_date"] is None,
        not bool(app_meta[appid]["search_eligible"]),
        appid,
    ))
    if ranked and sum(
        (
            str(app_meta[x]["app_type"] or "").lower() in {"game"}
            and app_meta[x]["release_date"] is not None
            and bool(app_meta[x]["search_eligible"])
        ) for x in ranked
    ) == 1:
        return ranked[0], "exact-preferred"
    return None, "ambiguous"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pool", type=Path, default=Path("docs/pool/steamguess_progressive_pool_v0.2.json"))
    parser.add_argument("--db", type=Path, default=Path("data/catalog/catalog.sqlite"))
    parser.add_argument("--resolved-out", type=Path, default=Path("data/catalog/curated_pool_v0.2.resolved.json"))
    args = parser.parse_args()

    source = load_games(args.pool)
    conn = connect(args.db)
    initialize(conn)
    rows = conn.execute("SELECT appid, canonical_name, app_type, release_date, search_eligible FROM apps").fetchall()
    meta = {int(row["appid"]): row for row in rows}
    names: defaultdict[str, set[int]] = defaultdict(set)
    bases: defaultdict[str, set[int]] = defaultdict(set)
    for row in rows:
        appid = int(row["appid"])
        names[normalize(row["canonical_name"])].add(appid)
        bases[base_name(row["canonical_name"])].add(appid)
    for row in conn.execute("SELECT appid, name FROM app_names"):
        names[normalize(row["name"])].add(int(row["appid"]))
        bases[base_name(row["name"])].add(int(row["appid"]))

    resolved: list[dict[str, Any]] = []
    unresolved: list[dict[str, Any]] = []
    used: set[int] = set()
    for item in source:
        title = str(item["game"]).strip()
        candidates = names.get(normalize(title), set())
        method = "exact"
        if not candidates:
            candidates = bases.get(base_name(title), set())
            method = "base-name"
        appid, chosen_method = choose(candidates, meta) if candidates else (None, "unmatched")
        if appid is None or appid in used:
            unresolved.append({**item, "reason": chosen_method if appid is None else "duplicate_appid"})
            continue
        used.add(appid)
        rank = int(item["difficulty"])
        resolved.append({
            "appId": appid, "game": title, "difficulty": rank,
            "tier": TIERS[rank], "basis": item.get("basis"),
            "userRating": item.get("user_rating"),
            "matchMethod": chosen_method if chosen_method != "exact" else method,
            "sourceVersion": "0.2",
        })

    # Keep the requested 75/200/325/600 cumulative shape. Source order is the
    # curation order; heuristic fill is explicitly marked as such.
    selected: list[dict[str, Any]] = []
    by_rank = {rank: [row for row in resolved if row["difficulty"] == rank] for rank in TIERS}
    for rank, target in TARGET_EXCLUSIVE.items():
        bucket = by_rank[rank][:target]
        selected.extend(bucket)
        missing = target - len(bucket)
        if missing <= 0:
            continue
        excluded = {row["appId"] for row in selected} | used
        candidates = conn.execute("""
            SELECT a.appid, a.canonical_name, a.search_eligible,
                   COALESCE(s.difficulty_score, 50) AS score
            FROM apps a LEFT JOIN app_scores s ON s.appid = a.appid
            WHERE lower(COALESCE(s.difficulty_level, '')) = ?
              AND a.excluded = 0
            ORDER BY a.search_eligible DESC, score ASC, a.appid
        """, (TIERS[rank],)).fetchall()
        for candidate in candidates:
            if missing <= 0: break
            if int(candidate["appid"]) in excluded: continue
            selected.append({
                "appId": int(candidate["appid"]), "game": candidate["canonical_name"],
                "difficulty": rank, "tier": TIERS[rank], "basis": "Heuristic fill",
                "userRating": None, "matchMethod": "heuristic-fill", "sourceVersion": "0.2",
            })
            excluded.add(int(candidate["appid"]))
            missing -= 1
        if missing:
            raise RuntimeError(f"Cannot fill difficulty {TIERS[rank]} by {missing} games")

    now = utc_now()
    conn.commit()
    conn.execute("BEGIN")
    try:
        conn.execute("DELETE FROM curated_pool_entries WHERE pool_version = ?", ("0.2",))
        for row in selected:
            conn.execute("""
                INSERT INTO curated_pool_entries(
                    pool_version, appid, source_name, difficulty_rank, tier,
                    basis, user_rating, match_method, included_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, ("0.2", row["appId"], row["game"], row["difficulty"], row["tier"],
                  row.get("basis"), row.get("userRating"), row["matchMethod"], now))
            conn.execute("""
                INSERT INTO catalog_memberships(catalog, appid, included_at, reason)
                VALUES (?, ?, ?, ?) ON CONFLICT(catalog, appid) DO UPDATE SET
                    included_at=excluded.included_at, reason=excluded.reason
            """, (f"curated:{row['tier']}", row["appId"], now, "progressive pool v0.2"))
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    args.resolved_out.parent.mkdir(parents=True, exist_ok=True)
    args.resolved_out.write_text(json.dumps({
        "version": "0.2", "model": "cumulative", "targets": {"easy": 75, "normal": 200, "hard": 325, "hell": 600},
        "exclusiveAdditions": TARGET_EXCLUSIVE, "games": selected,
        "unresolved": unresolved,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"source={len(source)} resolved={len(resolved)} selected={len(selected)} unresolved={len(unresolved)}")
    print("exclusive=" + json.dumps({rank: sum(row["difficulty"] == rank for row in selected) for rank in TIERS}))
    print(f"resolved_out={args.resolved_out}")


if __name__ == "__main__":
    main()
