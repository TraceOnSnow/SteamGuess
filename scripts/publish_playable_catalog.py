#!/usr/bin/env python3
"""Apply stable list prices from SteamSpy to the current playable catalog.

Steam Storefront's `final` price can include a temporary sale. SteamSpy's
`initialprice` is used as the regular/list price so comparisons remain stable.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def values(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        return [value for value in payload.values() if isinstance(value, dict)]
    raise ValueError("Playable catalog must be an array or object")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", default="data/catalog/steamspy_top_2000.json")
    parser.add_argument("--playable", default="public/games_demo.json")
    parser.add_argument("--out", default="public/games_demo.json")
    args = parser.parse_args()

    catalog = json.loads(Path(args.catalog).read_text(encoding="utf-8"))
    playable_payload = json.loads(Path(args.playable).read_text(encoding="utf-8"))
    catalog_games = {int(game["appId"]): game for game in catalog["games"]}
    regular_prices = {
        int(game["appId"]): int(game["metrics"].get("initialPriceCents", 0)) / 100
        for game in catalog["games"]
    }

    updated = 0
    for game in values(playable_payload):
        appid = int(game["appId"])
        if appid not in regular_prices:
            continue
        source = catalog_games[appid]
        if source.get("localizedNames"):
            game["localizedNames"] = source["localizedNames"]
        old_us = game.get("price", {}).get("us", {})
        game["price"] = {
            "us": {
                "currency": old_us.get("currency") or "USD",
                "regular": regular_prices[appid],
            },
            "cn": game.get("price", {}).get("cn", {}),
        }
        updated += 1

    out = Path(args.out)
    out.write_text(json.dumps(playable_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"regular_prices={updated} out={out}")


if __name__ == "__main__":
    main()
