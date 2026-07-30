#!/usr/bin/env python3
"""Build the compact browser catalog used by the internal difficulty labeler."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from scripts.catalog.common import split_company_names


def load_demo(path: Path) -> dict[int, dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    values = payload if isinstance(payload, list) else payload.values()
    return {int(game["appId"]): game for game in values if isinstance(game, dict) and game.get("appId")}


def compact_game(game: dict[str, Any], demo: dict[int, dict[str, Any]]) -> dict[str, Any]:
    appid = int(game["appId"])
    rich = demo.get(appid, {})
    tags = rich.get("tags", {})
    pics_tags = [str(tag.get("name") or "") for tag in game.get("tags", []) if tag.get("name")]
    hints = rich.get("hints", {})
    return {
        "appId": appid,
        "name": game["name"],
        "localizedNames": game.get("localizedNames", {}),
        "appType": game.get("type"),
        "developers": split_company_names(tags.get("developers", []) or game.get("developers", [])),
        "publishers": split_company_names(tags.get("publishers", []) or game.get("publishers", [])),
        "userTags": tags.get("userTags", []) or pics_tags,
        "headerImage": rich.get("header_image"),
        "screenshotUrl": hints.get("screenshotUrl"),
        "metrics": game["metrics"],
        "recognitionScore": game["recognition"]["score"],
        "recognitionFeatures": game["recognition"]["features"],
        "suggestedLevel": game["difficulty"]["level"],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", default="data/catalog/steamspy_top_2000.json")
    parser.add_argument("--demo", default="public/games_demo.json")
    parser.add_argument("--out", default="public/labeling_catalog.json")
    args = parser.parse_args()

    catalog = json.loads(Path(args.catalog).read_text(encoding="utf-8"))
    demo = load_demo(Path(args.demo))
    games = [compact_game(game, demo) for game in catalog["games"]]
    payload = {
        "schemaVersion": 1,
        "generatedAt": catalog["generatedAt"],
        "sourceCatalog": Path(args.catalog).name,
        "games": games,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    enriched = sum(bool(game["userTags"] or game["headerImage"]) for game in games)
    print(f"published={len(games)} enriched={enriched} out={out}")


if __name__ == "__main__":
    main()
