#!/usr/bin/env python3
"""Build the two published data files from the previous snapshot plus fetched gaps.

Outputs
  data/curated/answers.json   the answer list: who is in it and at which tier
  public/games_demo.json      every searchable game with its clue data

Inputs kept by hand in data/curated/: overrides.json (exclusions, forced tiers),
supplement.json (games the bulk listing misses), zh_names.json (Chinese names
the store lacks) and tga.json (The Game Awards nominees, for the TGA preset).

``answers.json`` is the authority for membership, tier and aliases.  Without
``--reselect`` an existing list is kept as is (so hand edits survive) and only
the game data around it is rebuilt.
"""
from __future__ import annotations

import argparse
import json
import math
import re
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MONTHS = {name: index for index, name in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
MAX_SCREENSHOTS = 6


def iso_date(value) -> str:
    """Normalise Storefront date strings to YYYY-MM-DD ('' when unknown)."""
    text = str(value or "").strip()
    if not text:
        return ""
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})", text)
    if match:
        return match.group(0)
    match = re.match(r"^(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?$", text)
    if match:
        return safe_date(int(match[1]), int(match[2]), int(match[3] or 1))
    match = re.match(r"^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})$", text)  # Nov 8, 2021
    if match and match[1].lower() in MONTHS:
        return safe_date(int(match[3]), MONTHS[match[1].lower()], int(match[2]))
    match = re.match(r"^(\d{1,2}) ([A-Za-z]{3})[a-z]*\.?,? (\d{4})$", text)  # 8 Nov, 2021
    if match and match[2].lower() in MONTHS:
        return safe_date(int(match[3]), MONTHS[match[2].lower()], int(match[1]))
    match = re.match(r"^([A-Za-z]{3})[a-z]*\.? (\d{4})$", text)  # Nov 2021
    if match and match[1].lower() in MONTHS:
        return safe_date(int(match[2]), MONTHS[match[1].lower()], 1)
    match = re.match(r"^(\d{4})$", text)
    if match:
        return safe_date(int(match[1]), 1, 1)
    return ""


def safe_date(year: int, month: int, day: int) -> str:
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return ""


def edition_key(name: str) -> str:
    value = name.casefold().replace("™", "").replace("®", "")
    value = re.sub(r"\b(game of the year|goty|special|enhanced|definitive|ultimate|anniversary|complete|legendary|remastered|remaster)( edition)?\b", "", value)
    return re.sub(r"[^\w]", "", value)


def store_price(details):
    """Regular price from a Storefront record: 0 when free, None when not sold."""
    if not details:
        return None
    if details.get("price"):
        return round(details["price"]["initialCents"] / 100, 2)
    return 0.0 if details.get("isFree") else None


def clean_game(old: dict, state: dict, curated: dict | None = None) -> dict:
    appid = str(old["appId"])
    curated = curated or {}
    us = state["us"].get(appid)
    cn = state["cn"].get(appid)
    old_price = old.get("price") or {}

    usd = store_price(us) if us else (old_price.get("us") or {}).get("regular")
    if us is None and appid in state["us"]:
        usd = None  # the store no longer lists it
    cny = (old_price.get("cn") or {}).get("regular")
    if cny is None and cn:
        cny = store_price(cn)
    # Free games that are simply not listed in one region are still free there.
    if cny is None and usd == 0:
        cny = 0.0
    if usd is None and cny == 0:
        usd = 0.0

    name = (us or {}).get("name") or old["name"]
    zh = (old.get("localizedNames") or {}).get("zh") or ""
    if not zh or zh in (name, old["name"]):  # an untranslated placeholder is not a Chinese name
        zh = (cn or {}).get("name") or ""
    zh = curated.get("zh", {}).get(appid) or zh
    metacritic = state.get("meta", {}).get(appid)
    if metacritic is None:
        metacritic = (us or {}).get("metacritic")
    old_tags = old.get("tags") or {}
    game = {
        "appId": old["appId"],
        "name": name,
        "localizedNames": {"zh": zh} if zh and zh != name else {},
        "aliases": [alias for alias in old.get("aliases", []) if alias not in (name, zh)],
        "type": ((us or {}).get("type") or old.get("type") or "").lower(),
        "releaseDate": iso_date((us or {}).get("releaseDate")) or iso_date(old.get("releaseDate")),
        "price": {"us": {"regular": usd}, "cn": {"regular": cny}},
        "reviews": old.get("reviews") or {"total": 0, "positive": 0, "negative": 0},
        "popularity": {"ccu": (old.get("popularity") or {}).get("ccu") or 0},
        "tags": {
            "userTags": old_tags.get("userTags") or state["spy"].get(appid) or [],
            "developers": old_tags.get("developers") or (us or {}).get("developers") or [],
            "publishers": old_tags.get("publishers") or (us or {}).get("publishers") or [],
        },
        "header_image": (us or {}).get("headerImage") or old.get("header_image") or "",
        "metacritic": metacritic if isinstance(metacritic, int) else old.get("metacritic"),
    }
    if curated.get("tga", {}).get(appid):
        game["tga"] = curated["tga"][appid]
    shots = [item["path"] for item in (us or {}).get("screenshots", []) if item.get("path")]
    shots = shots or (old.get("hints") or {}).get("screenshotUrls") or []
    game["_screenshots"] = shots[:MAX_SCREENSHOTS]
    return game


def searchable(game: dict) -> bool:
    # A missing price is allowed: delisted classics stay guessable and show "not sold".
    return bool(game["type"] == "game" and game["releaseDate"] and game["tags"]["userTags"]
                and game["reviews"].get("total", 0) > 0)


def heat(game: dict, max_reviews: float, max_ccu: float) -> float:
    reviews = math.log1p(game["reviews"].get("total", 0)) / max_reviews
    ccu = math.log1p(game["popularity"]["ccu"]) / max_ccu if max_ccu else 0
    return 0.85 * reviews + 0.15 * ccu


def select_answers(games: list[dict], edition: dict, overrides: dict) -> list[dict]:
    """Rank every eligible game by heat and cut the tiers at the edition caps."""
    max_reviews = max(math.log1p(game["reviews"].get("total", 0)) for game in games)
    max_ccu = max(math.log1p(game["popularity"]["ccu"]) for game in games)
    excluded = set(overrides.get("exclude", []))
    eligible = [game for game in games
                if searchable(game) and game["_screenshots"] and game["appId"] not in excluded]
    eligible.sort(key=lambda game: -heat(game, max_reviews, max_ccu))
    forced = {int(appid): level for appid, level in overrides.get("level", {}).items()}
    # Games with a hand-set tier are always in, even when their heat is below the cut.
    ordered = [game for game in eligible if game["appId"] in forced] + [game for game in eligible if game["appId"] not in forced]
    selected, seen = [], set()
    for game in ordered:
        key = edition_key(game["name"])
        if key in seen:
            continue
        seen.add(key)
        selected.append(game)
        if len(selected) == edition["answerLimit"]:
            break
    rank = {game["appId"]: index for index, game in enumerate(eligible)}
    selected.sort(key=lambda game: rank[game["appId"]])
    # Hand-set tiers take their seats first; everyone else fills the remaining
    # seats of each tier in heat order, so the tier sizes always match the caps.
    levels, caps = edition["levels"], edition["rankCaps"]
    seats = {level: caps[level] - (caps[levels[index - 1]] if index else 0) for index, level in enumerate(levels)}
    assigned = {}
    for game in selected:
        level = forced.get(game["appId"])
        if level in seats and seats[level] > 0:
            assigned[game["appId"]] = level
            seats[level] -= 1
    for game in selected:
        if game["appId"] in assigned:
            continue
        level = next(level for level in levels if seats[level] > 0)
        assigned[game["appId"]] = level
        seats[level] -= 1
    selected.sort(key=lambda game: levels.index(assigned[game["appId"]]))  # stable: heat order within a tier
    return [{"appId": game["appId"], "name": game["name"], "nameZh": game["localizedNames"].get("zh", ""),
             "aliases": game["aliases"], "level": assigned[game["appId"]], "rank": rank}
            for rank, game in enumerate(selected, 1)]


def load_curated(zh_path: Path, tga_path: Path) -> dict:
    """Hand-maintained extras: Chinese names and The Game Awards nominations."""
    zh = json.loads(zh_path.read_text(encoding="utf-8"))["names"] if zh_path.exists() else {}
    tga: dict[str, list[int]] = {}
    if tga_path.exists():
        for year, appids in sorted(json.loads(tga_path.read_text(encoding="utf-8"))["gameOfTheYear"].items()):
            for appid in appids:
                tga.setdefault(str(appid), []).append(int(year))
    return {"zh": zh, "tga": tga}


def supplement_games(path: Path, known: set[int], state: dict, minimum_reviews: int) -> list[dict]:
    """Turn fetched supplement entries into snapshot-shaped rows (see fetch_supplement.py)."""
    if not path.exists():
        return []
    rows = []
    for appid, entry in json.loads(path.read_text(encoding="utf-8")).items():
        spy, us, page = entry.get("spy") or {}, entry.get("us"), entry.get("page") or {}
        if int(appid) in known or not us:
            continue
        # SteamSpy has no numbers for some of these; the store page fills in.
        positive, negative = spy.get("positive", 0), spy.get("negative", 0)
        if positive + negative < page.get("reviews", 0):
            positive = round(page["reviews"] * page["positivePercent"] / 100)
            negative = page["reviews"] - positive
        if positive + negative < minimum_reviews:
            continue
        state["us"][appid] = us
        state["cn"][appid] = entry.get("cn")
        rows.append({
            "appId": int(appid), "name": us.get("name") or spy.get("name"),
            "reviews": {"total": positive + negative, "positive": positive, "negative": negative},
            "popularity": {"ccu": max(spy.get("ccu", 0), entry.get("players") or 0)},
            "tags": {"userTags": spy.get("tags") or page.get("tags") or [],
                     "developers": us.get("developers") or [], "publishers": us.get("publishers") or []},
        })
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, default=ROOT / "public/games_demo.json")
    parser.add_argument("--source", type=Path, help="Read game data from this snapshot instead of --snapshot")
    parser.add_argument("--state", type=Path, default=ROOT / "data/processed/gap_fill_state.json")
    parser.add_argument("--answers", type=Path, default=ROOT / "data/curated/answers.json")
    parser.add_argument("--supplement", type=Path, default=ROOT / "data/processed/supplement_state.json")
    parser.add_argument("--supplement-min-reviews", type=int, default=3000)
    parser.add_argument("--zh-names", type=Path, default=ROOT / "data/curated/zh_names.json")
    parser.add_argument("--tga", type=Path, default=ROOT / "data/curated/tga.json")
    parser.add_argument("--overrides", type=Path, default=ROOT / "data/curated/overrides.json")
    parser.add_argument("--reselect", action="store_true", help="Rebuild the answer list instead of keeping answers.json")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    edition = json.loads((ROOT / "shared/edition.json").read_text(encoding="utf-8"))
    state = {"us": {}, "cn": {}, "spy": {}}
    if args.state.exists():
        state.update(json.loads(args.state.read_text(encoding="utf-8")))
    overrides = json.loads(args.overrides.read_text(encoding="utf-8")) if args.overrides.exists() else {}
    old_games = list(json.loads((args.source or args.snapshot).read_text(encoding="utf-8")).values())
    old_games += supplement_games(args.supplement, {game["appId"] for game in old_games}, state, args.supplement_min_reviews)
    curated = load_curated(args.zh_names, args.tga)
    games = [clean_game(game, state, curated) for game in old_games]

    if args.answers.exists() and not args.reselect:
        answers = json.loads(args.answers.read_text(encoding="utf-8"))["games"]
    else:
        answers = select_answers(games, edition, overrides)

    by_id = {game["appId"]: game for game in games}
    answer_by_id = {entry["appId"]: entry for entry in answers}
    published = {}
    for game in games:
        entry = answer_by_id.get(game["appId"])
        shots = game.pop("_screenshots")
        if entry:
            game["aliases"] = entry.get("aliases", game["aliases"])
            zh = curated["zh"].get(str(game["appId"])) or entry.get("nameZh")
            if zh and zh != game["name"]:
                game["localizedNames"] = {"zh": zh}
            game["hints"] = {"screenshotUrls": shots}
            game["difficulty"] = {"level": entry["level"]}
        elif not searchable(game):
            continue
        published[str(game["appId"])] = game
    # Keep the catalog at the edition size: every answer, then the best-known rest.
    extras = sorted((game for game in published.values() if "difficulty" not in game), key=lambda game: -game["reviews"]["total"])
    for game in extras[max(0, edition["searchLimit"] - len(answers)):]:
        del published[str(game["appId"])]
    # Answers first, in rank order, so a truncated read is still playable.
    order = {entry["appId"]: index for index, entry in enumerate(answers)}
    published = dict(sorted(published.items(), key=lambda item: order.get(int(item[0]), len(order))))

    counts = {level: sum(entry["level"] == level for entry in answers) for level in edition["levels"]}
    missing = [entry["appId"] for entry in answers if entry["appId"] not in by_id]
    print(json.dumps({"answers": len(answers), "byLevel": counts, "searchable": len(published),
                      "candidates": len(games), "missingAnswerData": missing}, ensure_ascii=False))
    if args.dry_run:
        return
    args.answers.write_text(json.dumps({
        "version": 3,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "policy": {
            "ranking": "0.85 * log(reviews) + 0.15 * log(ccu), SteamSpy snapshot",
            "rankCaps": edition["rankCaps"],
            "note": "Tiers are cumulative. Edit level/aliases here by hand; rebuild with npm run data:build.",
        },
        "games": answers,
    }, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    args.snapshot.write_text(json.dumps(published, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
