#!/usr/bin/env python3
"""One-off, resumable gap filler for the published snapshot.

Fetches the Steam Storefront (US/English for every game, CN/Chinese only where
the mainland price or Chinese name is missing), SteamSpy tags (only where
user tags are missing) and the Metacritic score of every answer.  Results are checkpointed to a state file; nothing in
the snapshot is modified here -- ``build_snapshot.py`` merges the state.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
UA = {"User-Agent": "Mozilla/5.0 (compatible; catalog-fetch/1.0)"}


def extract_storefront_details(payload, appid: int):
    """Reduce an appdetails response to the fields the snapshot needs."""
    entry = payload.get(str(appid)) if isinstance(payload, dict) else None
    if not isinstance(entry, dict) or entry.get("success") is not True:
        return None
    data = entry.get("data")
    if not isinstance(data, dict):
        return None

    name = str(data.get("name") or "").strip() or None
    is_free = data.get("is_free") is True
    price = data.get("price_overview")
    release_date = data.get("release_date")
    release_text = release_date.get("date") if isinstance(release_date, dict) else None
    result = {
        "name": name,
        "isFree": is_free,
        "price": None,
        "type": str(data.get("type") or "").strip() or None,
        "releaseDate": str(release_text or "").strip() or None,
        "developers": [str(value).strip() for value in data.get("developers", []) if str(value).strip()],
        "publishers": [str(value).strip() for value in data.get("publishers", []) if str(value).strip()],
        "screenshots": [
            {
                "id": item.get("id"),
                "path": str(item.get("path_full") or item.get("path_thumbnail") or "").strip(),
                "pathThumbnail": str(item.get("path_thumbnail") or "").strip(),
            }
            for item in data.get("screenshots", [])
            if isinstance(item, dict) and (item.get("path_full") or item.get("path_thumbnail"))
        ],
        "headerImage": str(data.get("header_image") or "").strip() or None,
        "metacritic": None,
    }
    metacritic = data.get("metacritic")
    if isinstance(metacritic, dict) and isinstance(metacritic.get("score"), int):
        result["metacritic"] = metacritic["score"]
    if isinstance(price, dict):
        initial = price.get("initial")
        final = price.get("final")
        if isinstance(initial, int) and initial >= 0:
            result["price"] = {
                "currency": str(price.get("currency") or "").upper(),
                "initialCents": initial,
                "finalCents": final if isinstance(final, int) and final >= 0 else initial,
                "discountPercent": int(price.get("discount_percent") or 0),
            }
    return result


def get_json(url: str, timeout: float = 25):
    with urlopen(Request(url, headers=UA), timeout=timeout) as response:
        return json.load(response)


def with_retry(fn, label: str):
    for attempt in range(6):
        try:
            return fn()
        except HTTPError as error:
            if error.code in (429, 403, 502, 503):
                wait = 300 if error.code in (429, 403) else 30
                print(f"{label}: HTTP {error.code}, waiting {wait}s", flush=True)
                time.sleep(wait)
                continue
            print(f"{label}: HTTP {error.code}", flush=True)
            return "error"
        except (URLError, TimeoutError, OSError, ValueError) as error:
            print(f"{label}: {error!r}, retry", flush=True)
            time.sleep(15 * (attempt + 1))
    return "error"


def store(appid: int, language: str, country: str):
    query = urlencode({"appids": appid, "l": language, "cc": country})
    payload = get_json(f"https://store.steampowered.com/api/appdetails?{query}")
    return extract_storefront_details(payload, appid)  # None => not available


def spy_tags(appid: int):
    payload = get_json(f"https://steamspy.com/api.php?request=appdetails&appid={appid}")
    tags = payload.get("tags") if isinstance(payload, dict) else None
    if not isinstance(tags, dict):
        return []
    return [name for name, _ in sorted(tags.items(), key=lambda item: -int(item[1] or 0))][:20]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, default=ROOT / "public/games_demo.json")
    parser.add_argument("--state", type=Path, default=ROOT / "data/processed/gap_fill_state.json")
    parser.add_argument("--answers", type=Path, default=ROOT / "data/curated/answers.json")
    parser.add_argument("--delay", type=float, default=1.6)
    args = parser.parse_args()

    games = list(json.loads(args.snapshot.read_text(encoding="utf-8")).values())
    state = {"us": {}, "cn": {}, "spy": {}, "meta": {}}
    if args.state.exists():
        state.update(json.loads(args.state.read_text(encoding="utf-8")))

    def save() -> None:
        tmp = args.state.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
        tmp.replace(args.state)

    def needs_cn(game) -> bool:
        cn = (game.get("price") or {}).get("cn") or {}
        zh = (game.get("localizedNames") or {}).get("zh")
        return cn.get("regular") is None or not zh or zh == game.get("name")

    jobs = []
    # Answer candidates (first 1000) first, so a partial run is still useful.
    for game in games:
        jobs.append(("us", game["appId"]))
    for game in games:
        if not (game.get("tags") or {}).get("userTags"):
            jobs.append(("spy", game["appId"]))
        if needs_cn(game):
            jobs.append(("cn", game["appId"]))

    # The first US pass predates the Metacritic field, so answers get one more look.
    if args.answers.exists():
        jobs += [("meta", entry["appId"]) for entry in json.loads(args.answers.read_text(encoding="utf-8"))["games"]]

    pending = [(kind, appid) for kind, appid in jobs if str(appid) not in state[kind]]
    print(f"jobs={len(jobs)} pending={len(pending)}", flush=True)
    for index, (kind, appid) in enumerate(pending, 1):
        if kind == "us":
            result = with_retry(lambda: store(appid, "english", "us"), f"us {appid}")
        elif kind == "cn":
            result = with_retry(lambda: store(appid, "schinese", "cn"), f"cn {appid}")
        elif kind == "meta":
            result = with_retry(lambda: store(appid, "english", "us"), f"meta {appid}")
            result = result if result == "error" else (result or {}).get("metacritic")
        else:
            result = with_retry(lambda: spy_tags(appid), f"spy {appid}")
        if result != "error":
            state[kind][str(appid)] = result
        if index % 20 == 0:
            save()
            print(f"{index}/{len(pending)}", flush=True)
        time.sleep(args.delay)
    save()
    print("done", {kind: len(values) for kind, values in state.items()}, flush=True)


if __name__ == "__main__":
    main()
