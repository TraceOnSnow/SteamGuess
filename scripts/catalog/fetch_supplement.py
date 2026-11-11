#!/usr/bin/env python3
"""Fetch well-known games that the SteamSpy bulk listing missed.

Candidates are Steam's own most-played chart plus the hand list in
``data/curated/supplement.json``.  Anything already in the snapshot is skipped.
Each candidate gets SteamSpy details (reviews, players, tags) and Storefront
data for both regions; ``build_snapshot.py`` decides which ones qualify.
"""
from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path
from urllib.request import Request, urlopen

from scripts.catalog.fetch_gaps import UA, get_json, store, with_retry

ROOT = Path(__file__).resolve().parents[2]
CHART = "https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/"


def spy(appid: int):
    data = get_json(f"https://steamspy.com/api.php?request=appdetails&appid={appid}")
    if not isinstance(data, dict) or not data.get("name"):
        return None
    tags = data.get("tags") if isinstance(data.get("tags"), dict) else {}
    return {
        "name": data["name"],
        "positive": int(data.get("positive") or 0),
        "negative": int(data.get("negative") or 0),
        "ccu": int(data.get("ccu") or 0),
        "developers": [part.strip() for part in str(data.get("developer") or "").split(",") if part.strip()],
        "publishers": [part.strip() for part in str(data.get("publisher") or "").split(",") if part.strip()],
        "tags": [name for name, _ in sorted(tags.items(), key=lambda item: -int(item[1] or 0))][:20],
    }


def store_page(appid: int):
    """Tags and review totals straight from the store page, for games SteamSpy has no numbers on."""
    request = Request(f"https://store.steampowered.com/app/{appid}/?l=english&cc=us",
                      headers={**UA, "Cookie": "birthtime=0; wants_mature_content=1; lastagecheckage=1-0-1990"})
    with urlopen(request, timeout=30) as response:
        html = response.read().decode("utf-8", "ignore")
    tags = re.search(r"InitAppTagModal\(\s*\d+,\s*(\[.*?\])\s*,", html, re.S)
    summaries = [(int(count.replace(",", "")), int(percent))
                 for percent, count in re.findall(r'data-tooltip-html="(\d+)% of the ([\d,]+) user reviews', html)]
    total, percent = max(summaries, default=(0, 0))
    return {"tags": [item["name"] for item in json.loads(tags.group(1))][:20] if tags else [],
            "reviews": total, "positivePercent": percent}


def players(appid: int):
    data = get_json(f"https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid={appid}")
    return int(data.get("response", {}).get("player_count") or 0)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--known", type=Path, default=ROOT / "public/games_demo.json")
    parser.add_argument("--list", type=Path, default=ROOT / "data/curated/supplement.json")
    parser.add_argument("--state", type=Path, default=ROOT / "data/processed/supplement_state.json")
    parser.add_argument("--delay", type=float, default=2.5)
    args = parser.parse_args()

    known = {int(appid) for appid in json.loads(args.known.read_text(encoding="utf-8"))}
    wanted = [int(appid) for appid in json.loads(args.list.read_text(encoding="utf-8"))["appIds"]] if args.list.exists() else []
    chart = with_retry(lambda: get_json(CHART), "chart")
    if chart != "error":
        wanted += [int(row["appid"]) for row in chart["response"]["ranks"]]
    wanted = [appid for appid in dict.fromkeys(wanted) if appid not in known]

    state = json.loads(args.state.read_text(encoding="utf-8")) if args.state.exists() else {}
    for index, appid in enumerate(wanted, 1):
        entry = state.setdefault(str(appid), {})
        for kind, fetch in (("spy", lambda: spy(appid)), ("us", lambda: store(appid, "english", "us")), ("cn", lambda: store(appid, "schinese", "cn")),
                            ("page", lambda: store_page(appid)), ("players", lambda: players(appid))):
            if kind in entry:
                continue
            result = with_retry(fetch, f"{kind} {appid}")
            if result != "error":
                entry[kind] = result
            time.sleep(args.delay)
        args.state.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
        print(f"{index}/{len(wanted)} {appid} {(entry.get('spy') or {}).get('name')}", flush=True)


if __name__ == "__main__":
    main()
