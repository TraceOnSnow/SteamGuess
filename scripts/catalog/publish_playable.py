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
import re
import sqlite3
from pathlib import Path
from typing import Any

from scripts.catalog.common import split_company_names


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


def hint_review(source: dict[str, Any], previous: dict[str, Any]) -> str:
    """Pick one stored review without making a network request.

    Prefer the localized review, then English.  Mask the known game names so
    the hint does not trivially reveal the answer while preserving the review
    wording and punctuation.
    """
    old_hints = previous.get("hints", {}) if isinstance(previous.get("hints", {}), dict) else {}
    existing = str(old_hints.get("funnyReview") or "").strip()
    if existing:
        return existing
    reviews = source.get("reviews", {})
    if not isinstance(reviews, dict):
        return ""
    text = ""
    for language in ("schinese", "english"):
        items = reviews.get(language, [])
        if not isinstance(items, list):
            continue
        for item in items:
            if isinstance(item, dict) and str(item.get("text") or "").strip():
                text = str(item["text"]).strip()
                break
        if text:
            break
    if not text:
        return ""
    names = [source.get("name"), source.get("localizedNames", {}).get("zh") if isinstance(source.get("localizedNames"), dict) else None]
    for name in sorted({str(value).strip() for value in names if str(value or "").strip()}, key=len, reverse=True):
        text = re.sub(re.escape(name), "[游戏名称]", text, flags=re.IGNORECASE)
    return text


def header_image(appid: int, previous: dict[str, Any]) -> str:
    existing = str(previous.get("header_image") or "").strip()
    if existing:
        return existing
    return f"https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/{appid}/header.jpg"


def build_game(source: dict[str, Any], previous: dict[str, Any], cached_user_tags: list[str] | None = None) -> dict[str, Any]:
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
    previous_hints = previous.get("hints", {}) if isinstance(previous.get("hints", {}), dict) else {}
    screenshots = source.get("screenshots", []) if isinstance(source.get("screenshots", []), list) else []
    source_screenshot = next((str(item.get("path") or "").strip() for item in screenshots if isinstance(item, dict) and item.get("path")), "")
    source_hints = source.get("hints", {}) if isinstance(source.get("hints", {}), dict) else {}
    screenshot_url = str(previous_hints.get("screenshotUrl") or source_hints.get("screenshotUrl") or source_screenshot).strip()
    review_text = hint_review(source, previous)
    hints = {}
    if screenshot_url:
        hints["screenshotUrl"] = screenshot_url
    if review_text:
        hints["funnyReview"] = review_text
    difficulty = source.get("difficulty", {}) if isinstance(source.get("difficulty"), dict) else {}
    difficulty_score = difficulty.get("score")
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
        "difficulty": {
            "score": difficulty_score,
            "level": difficulty.get("level"),
            "confidence": 0,
            "source": difficulty.get("source"),
            "manualLevel": difficulty.get("manualLevel"),
        },
        "difficultyScore": difficulty_score,
        "difficultyLevel": difficulty.get("level"),
        "catalogStatus": "active",
        "tags": {
            "userTags": previous_tags.get("userTags") or tag_names(source) or (cached_user_tags or []),
            "developers": split_company_names(source.get("developers", []) or previous_tags.get("developers", [])),
            "publishers": split_company_names(source.get("publishers", []) or previous_tags.get("publishers", [])),
        },
        "hints": hints,
        "header_image": header_image(appid, previous),
    }


DIFFICULTY_DISTRIBUTION = (
    ("easy", 75),
    ("normal", 200),
    ("hard", 325),
    ("hell", 600),
)


def calibrated_counts(total: int) -> dict[str, int]:
    """Scale cumulative reference targets to the current playable size."""
    if total <= 0:
        return {level: 0 for level, _ in DIFFICULTY_DISTRIBUTION}
    boundaries = [min(total, round(total * target / DIFFICULTY_DISTRIBUTION[-1][1])) for _, target in DIFFICULTY_DISTRIBUTION]
    return {level: boundary for (level, _), boundary in zip(DIFFICULTY_DISTRIBUTION, boundaries, strict=True)}


def calibrate_difficulty_distribution(games: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Assign every published game a level using the reference pool proportions.

    The games themselves are not filtered. Existing numeric difficulty scores are
    retained for display/analysis; only the preset level is quantile-calibrated.
    """
    ordered = sorted(
        games.values(),
        key=lambda game: (
            float(game.get("difficultyScore") if isinstance(game.get("difficultyScore"), (int, float)) else 50.0),
            int(game["appId"]),
        ),
    )
    boundaries = calibrated_counts(len(ordered))
    cursor = 0
    for level, boundary in DIFFICULTY_DISTRIBUTION:
        end = boundaries[level]
        for game in ordered[cursor:end]:
            game["difficulty"]["level"] = level
            game["difficulty"]["source"] = "calibrated-distribution-v1"
            game["difficultyLevel"] = level
        cursor = end
    return games


def load_cached_user_tags(db_path: Path | None) -> dict[int, list[str]]:
    """Load persistent PICS tags when a refreshed JSON catalog lacks them."""
    if db_path is None or not db_path.exists():
        return {}
    connection = sqlite3.connect(db_path)
    try:
        rows = connection.execute(
            "SELECT appid, name FROM app_tags ORDER BY appid, position"
        ).fetchall()
    finally:
        connection.close()
    cached: dict[int, list[str]] = {}
    for appid, name in rows:
        names = cached.setdefault(int(appid), [])
        clean = str(name or "").strip()
        if clean and clean not in names and len(names) < 20:
            names.append(clean)
    return cached


def build_playable_catalog(
    catalog: dict[str, Any],
    playable_payload: Any,
    include_non_games: bool = False,
    cached_user_tags: dict[int, list[str]] | None = None,
) -> dict[str, dict[str, Any]]:
    previous = {int(game["appId"]): game for game in values(playable_payload) if game.get("appId")}
    result: dict[str, dict[str, Any]] = {}
    for source in catalog["games"]:
        if not include_non_games and str(source.get("type") or "").lower() != "game":
            continue
        appid = int(source["appId"])
        result[str(appid)] = build_game(source, previous.get(appid, {}), (cached_user_tags or {}).get(appid))
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
    parser.add_argument("--db", default="data/catalog/catalog.sqlite", help="Persistent catalog DB used as a PICS-tag cache")
    parser.add_argument("--out", default="public/games_demo.json")
    parser.add_argument("--include-non-games", action="store_true")
    parser.add_argument("--active-limit", type=int, default=0, help="Publish only the first N catalog rows; 0 means all")
    args = parser.parse_args()

    catalog = json.loads(Path(args.catalog).read_text(encoding="utf-8"))
    if args.active_limit > 0 and isinstance(catalog.get("games"), list):
        catalog = {**catalog, "games": catalog["games"][:args.active_limit]}
    playable_path = Path(args.playable)
    playable_payload = json.loads(playable_path.read_text(encoding="utf-8")) if playable_path.exists() else {}
    cached_user_tags = load_cached_user_tags(Path(args.db) if args.db else None)
    published = build_playable_catalog(catalog, playable_payload, args.include_non_games, cached_user_tags)
    published = calibrate_difficulty_distribution(published)

    out = Path(args.out)
    out.write_text(json.dumps(published, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    screenshots = sum(bool(game.get("hints", {}).get("screenshotUrl")) for game in published.values())
    reviews = sum(bool(game.get("hints", {}).get("funnyReview")) for game in published.values())
    localized = sum(bool(game.get("localizedNames", {}).get("zh")) for game in published.values())
    cn_prices = sum("regular" in game.get("price", {}).get("cn", {}) for game in published.values())
    counts = {level: sum(game.get("difficulty", {}).get("level") == level for game in published.values()) for level, _ in DIFFICULTY_DISTRIBUTION}
    tagged = sum(bool(game.get("tags", {}).get("userTags")) for game in published.values())
    print(f"source={len(catalog['games'])} published={len(published)} localized={localized} cn_prices={cn_prices} screenshots={screenshots} reviews={reviews} tagged={tagged} difficulty={counts} out={out}")


if __name__ == "__main__":
    main()
