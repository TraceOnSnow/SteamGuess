#!/usr/bin/env python3
"""Build the browser-playable catalog from the enriched SteamSpy candidate set.

Existing rich Storefront fields (release date and screenshot URL) are preserved.
New entries are published only from data already present in the catalog; this
script never performs network requests. Missing screenshots and release dates
remain missing instead of being fabricated.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def values(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [value for value in payload if isinstance(value, dict)]
    if isinstance(payload, dict):
        return [value for value in payload.values() if isinstance(value, dict)]
    raise ValueError("Playable catalog must be an array or object")


def published_cn_price(source: dict[str, Any]) -> dict[str, Any]:
    price = source.get("regionalPrices", {}).get("cn", {})
    if not isinstance(price, dict) or price.get("status") not in {"available", "free"}:
        return {}
    cents = price.get("regularCents")
    if not isinstance(cents, int) or cents < 0:
        return {}
    return {"currency": "CNY", "regular": cents / 100}


def tag_names(source: dict[str, Any]) -> list[str]:
    return [str(tag.get("name") or "").strip() for tag in source.get("tags", []) if str(tag.get("name") or "").strip()][:20]


def header_image(appid: int, previous: dict[str, Any]) -> str:
    existing = str(previous.get("header_image") or "").strip()
    if existing:
        return existing
    return f"https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/{appid}/header.jpg"


def build_game(source: dict[str, Any], previous: dict[str, Any]) -> dict[str, Any]:
    appid = int(source["appId"])
    metrics = source.get("metrics", {})
    positive = int(metrics.get("positive", 0) or 0)
    negative = int(metrics.get("negative", 0) or 0)
    old_popularity = previous.get("popularity", {})
    popularity = {
        "ccu": int(metrics.get("ccu", 0) or 0),
        "owners": int(metrics.get("ownersMax", 0) or 0),
    }
    for field in ("peakYesterday", "peak7d", "peak7dSamples"):
        if field in metrics:
            popularity[field] = metrics[field]
        elif field in old_popularity:
            popularity[field] = old_popularity[field]

    previous_tags = previous.get("tags", {})
    screenshot_url = str(previous.get("hints", {}).get("screenshotUrl") or "").strip()
    hints = {"screenshotUrl": screenshot_url} if screenshot_url else {}
    return {
        "appId": appid,
        "name": str(source.get("name") or f"App {appid}"),
        "localizedNames": source.get("localizedNames", {}),
        "releaseDate": str(previous.get("releaseDate") or source.get("releaseDate") or ""),
        "price": {
            "us": {
                "currency": str(previous.get("price", {}).get("us", {}).get("currency") or "USD"),
                "regular": int(metrics.get("initialPriceCents", 0) or 0) / 100,
            },
            "cn": published_cn_price(source),
        },
        "popularity": popularity,
        "reviews": {"total": positive + negative, "positive": positive, "negative": negative},
        "tags": {
            "userTags": previous_tags.get("userTags") or tag_names(source),
            "developers": source.get("developers", []) or previous_tags.get("developers", []),
            "publishers": source.get("publishers", []) or previous_tags.get("publishers", []),
        },
        "hints": hints,
        "header_image": header_image(appid, previous),
    }


def build_playable_catalog(catalog: dict[str, Any], playable_payload: Any, include_non_games: bool = False) -> dict[str, dict[str, Any]]:
    previous = {int(game["appId"]): game for game in values(playable_payload) if game.get("appId")}
    result: dict[str, dict[str, Any]] = {}
    for source in catalog["games"]:
        if not include_non_games and str(source.get("type") or "").lower() != "game":
            continue
        appid = int(source["appId"])
        result[str(appid)] = build_game(source, previous.get(appid, {}))
    return result


def publish(catalog: Any, playable_payload: Any) -> int:
    """Backward-compatible in-place enrichment used by focused unit tests."""
    catalog_games = {int(game["appId"]): game for game in catalog["games"]}
    updated = 0
    for game in values(playable_payload):
        source = catalog_games.get(int(game["appId"]))
        if not source:
            continue
        previous = dict(game)
        game.clear()
        game.update(build_game(source, previous))
        updated += 1
    return updated


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", default="data/catalog/steamspy_top_2000.json")
    parser.add_argument("--playable", default="public/games_demo.json")
    parser.add_argument("--out", default="public/games_demo.json")
    parser.add_argument("--include-non-games", action="store_true")
    args = parser.parse_args()

    catalog = json.loads(Path(args.catalog).read_text(encoding="utf-8"))
    playable_path = Path(args.playable)
    playable_payload = json.loads(playable_path.read_text(encoding="utf-8")) if playable_path.exists() else {}
    published = build_playable_catalog(catalog, playable_payload, args.include_non_games)

    out = Path(args.out)
    out.write_text(json.dumps(published, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    screenshots = sum(bool(game.get("hints", {}).get("screenshotUrl")) for game in published.values())
    localized = sum(bool(game.get("localizedNames", {}).get("zh")) for game in published.values())
    cn_prices = sum("regular" in game.get("price", {}).get("cn", {}) for game in published.values())
    print(f"source={len(catalog['games'])} published={len(published)} localized={localized} cn_prices={cn_prices} screenshots={screenshots} out={out}")


if __name__ == "__main__":
    main()
