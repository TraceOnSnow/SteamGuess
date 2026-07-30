#!/usr/bin/env python3
"""Merge PICS app types and ordered tags into the normalized game catalog."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", default="data/catalog/steamspy_top_2000.json")
    parser.add_argument("--pics", required=True)
    parser.add_argument("--out", default="data/catalog/steamspy_top_2000.json")
    args = parser.parse_args()

    catalog = json.loads(Path(args.catalog).read_text(encoding="utf-8"))
    pics = json.loads(Path(args.pics).read_text(encoding="utf-8"))
    pics_games = {int(appid): game for appid, game in pics.get("games", {}).items()}
    type_counts: Counter[str] = Counter()
    found = 0

    for game in catalog["games"]:
        appid = int(game["appId"])
        info = pics_games.get(appid)
        if not info:
            continue
        found += 1
        app_type = str(info.get("type") or "").strip() or None
        if app_type:
            type_counts[app_type] += 1
        game["type"] = app_type
        game["picsChangeNumber"] = info.get("changeNumber")
        game["tags"] = [
            {
                "id": int(tag["id"]),
                "rank": int(tag["rank"]),
                "name": str(tag.get("englishName") or tag.get("name") or ""),
            }
            for tag in info.get("tags", [])
            if tag.get("id") and (tag.get("englishName") or tag.get("name"))
        ]
        game["sources"] = [source for source in game.get("sources", []) if source.get("service") != "pics"]
        game["sources"].append({
            "service": "pics",
            "endpoint": "PICS ProductInfo",
            "retrievedAt": pics["generatedAt"],
        })
        game["fieldSources"]["type"] = "pics"
        game["fieldSources"]["tags"] = "pics"

    catalog["stats"]["picsFound"] = found
    catalog["stats"]["picsUnknown"] = len(pics.get("unknownAppIds", []))
    catalog["stats"]["appTypeCounts"] = dict(sorted(type_counts.items()))
    out = Path(args.out)
    out.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"merged={found} unknown={catalog['stats']['picsUnknown']} types={dict(type_counts)} out={out}")


if __name__ == "__main__":
    main()
