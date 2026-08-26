#!/usr/bin/env python3
"""Build the browser Search catalog from the enriched SteamSpy candidate set.

Existing rich Storefront fields (release date and screenshot URLs) are preserved.
New entries are published only from data already present in the catalog; this
script never performs network requests. Missing screenshots and release dates
remain missing instead of being fabricated.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any

from scripts.catalog.common import split_company_names
from scripts.catalog.review_redaction import build_redaction_entities, redact_review


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


def hint_reviews(
    source: dict[str, Any],
    redactions: dict[tuple[int, str, str, str], str] | None = None,
) -> list[str]:
    """Publish every stored review using AI or deterministic redaction.

    Raw review text remains in the persistent catalog. AI-cleaned text wins
    when its source hash still matches; otherwise the local rule-based
    redactor provides a safe, zero-cost fallback.
    """
    appid = int(source["appId"])
    entities = build_redaction_entities(source)
    result: list[str] = []
    reviews = source.get("reviews", {})
    if isinstance(reviews, dict):
        for language in ("schinese", "english"):
            items = reviews.get(language, [])
            if not isinstance(items, list):
                continue
            for item in items:
                if not isinstance(item, dict):
                    continue
                raw_text = str(item.get("text") or item.get("review") or "").strip()
                if not raw_text:
                    continue
                review_id = str(item.get("reviewId") or item.get("recommendationid") or "")
                review_hash = hashlib.sha256(raw_text.encode("utf-8")).hexdigest()
                text = (redactions or {}).get((appid, language, review_id, review_hash), "")
                if not text:
                    text = str(item.get("redactedText") or "").strip()
                if not text:
                    text = redact_review(raw_text, entities)
                if text and text not in result:
                    result.append(text)
    return result


def header_image(appid: int, previous: dict[str, Any]) -> str:
    existing = str(previous.get("header_image") or "").strip()
    if existing:
        return existing
    return f"https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/{appid}/header.jpg"


def build_game(
    source: dict[str, Any],
    previous: dict[str, Any],
    cached_user_tags: list[str] | None = None,
    review_redactions: dict[tuple[int, str, str, str], str] | None = None,
) -> dict[str, Any]:
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
    screenshots = source.get("screenshots", []) if isinstance(source.get("screenshots", []), list) else []
    screenshot_urls = list(dict.fromkeys(
        str(item.get("path") or "").strip()
        for item in screenshots
        if isinstance(item, dict) and str(item.get("path") or "").strip()
    ))
    review_texts = hint_reviews(source, review_redactions)
    hints = {}
    if screenshot_urls:
        hints["screenshotUrls"] = screenshot_urls
    if review_texts:
        hints["reviewTexts"] = review_texts
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
        "catalogStatus": "active",
        "tags": {
            "userTags": previous_tags.get("userTags") or tag_names(source) or (cached_user_tags or []),
            "developers": split_company_names(source.get("developers", []) or previous_tags.get("developers", [])),
            "publishers": split_company_names(source.get("publishers", []) or previous_tags.get("publishers", [])),
        },
        "hints": hints,
        "header_image": header_image(appid, previous),
    }


def load_difficulty_overrides(db_path: Path | None) -> dict[int, dict[str, Any]]:
    """Load editorial scores without coupling weekly imports to them."""
    if db_path is None or not db_path.exists():
        return {}
    connection = sqlite3.connect(db_path)
    try:
        exists = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'difficulty_overrides'"
        ).fetchone()
        if not exists:
            return {}
        rows = connection.execute(
            "SELECT appid, manual_score, locked, updated_at FROM difficulty_overrides"
        ).fetchall()
    finally:
        connection.close()
    return {
        int(appid): {
            "manualScore": float(manual_score) if manual_score is not None else None,
            "locked": bool(locked),
            "updatedAt": updated_at,
        }
        for appid, manual_score, locked, updated_at in rows
    }


def load_catalog_exclusions(db_path: Path | None) -> set[int]:
    if db_path is None or not db_path.exists():
        return set()
    connection = sqlite3.connect(db_path)
    try:
        exists = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'catalog_exclusions'"
        ).fetchone()
        if not exists:
            return set()
        return {
            int(row[0])
            for row in connection.execute("SELECT appid FROM catalog_exclusions")
        }
    finally:
        connection.close()


def load_ai_candidates(db_path: Path | None) -> dict[int, dict[str, Any]]:
    """Load the AI-reviewed baseline and its game eligibility decision."""
    if db_path is None or not db_path.exists():
        return {}
    connection = sqlite3.connect(db_path)
    try:
        exists = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'difficulty_ai_candidates'"
        ).fetchone()
        if not exists:
            return {}
        rows = connection.execute(
            """
            SELECT appid, score, level, confidence, eligible, exclusion_reason
            FROM difficulty_ai_candidates
            """
        ).fetchall()
    finally:
        connection.close()
    return {
        int(appid): {
            "score": int(score),
            "level": str(level),
            "confidence": float(confidence),
            "eligible": bool(eligible),
            "exclusionReason": exclusion_reason,
        }
        for appid, score, level, confidence, eligible, exclusion_reason in rows
    }


def select_publishable_catalog(
    catalog: dict[str, Any],
    excluded_appids: set[int],
    ai_candidates: dict[int, dict[str, Any]],
    active_limit: int,
) -> dict[str, Any]:
    """Select searchable rows from the literal SteamSpy Active window.

    Editorial exclusions are removed before the Active limit so the next
    ranked row fills their slot. Difficulty eligibility is intentionally
    applied *after* that window is fixed: an unscored or AI-ineligible row must
    not pull a lower-ranked game into Active merely because it cannot currently
    be used as an answer.

    Missing AI candidates remain searchable. An explicit ``eligible=false``
    decision means the row is software, noise, or otherwise unsuitable and is
    therefore removed from both search and answer catalogs.
    """
    games = catalog.get("games")
    if not isinstance(games, list):
        return catalog
    active = [
        game for game in games
        if isinstance(game, dict)
        and game.get("appId")
        and int(game["appId"]) not in excluded_appids
    ]
    if active_limit > 0:
        active = active[:active_limit]
    searchable = [
        game
        for game in active
        if ai_candidates.get(int(game["appId"]), {}).get("eligible") is not False
    ]
    return {**catalog, "games": searchable}


def level_for_score(score: float) -> str:
    if score < 15:
        return "beginner"
    if score < 25:
        return "easy"
    if score < 50:
        return "normal"
    if score < 75:
        return "hard"
    return "hell"


def apply_effective_difficulties(
    games: dict[str, dict[str, Any]],
    ai_candidates: dict[int, dict[str, Any]],
    overrides: dict[int, dict[str, Any]],
    feedback_scores: dict[int, dict[str, Any]] | None = None,
) -> dict[str, dict[str, Any]]:
    """Materialize AI baseline, accepted feedback, then editorial locks."""
    for game in games.values():
        appid = int(game["appId"])
        candidate = ai_candidates.get(appid)
        if not candidate or not candidate.get("eligible"):
            continue
        base_score = float(candidate["score"])
        difficulty = {
            "score": base_score,
            "level": level_for_score(base_score),
            "confidence": float(candidate.get("confidence", 0)),
            "source": "ai-candidate",
            "aiCandidateScore": base_score,
            "aiCandidateLevel": candidate.get("level") or level_for_score(base_score),
        }
        game["difficulty"] = difficulty
        game["difficultyScore"] = base_score
        game["difficultyLevel"] = difficulty["level"]
        feedback = (feedback_scores or {}).get(appid)
        difficulty["feedbackScore"] = feedback.get("score") if feedback else None
        difficulty["feedbackStatus"] = feedback.get("status") if feedback else None
        difficulty["feedbackCount"] = feedback.get("sampleCount", 0) if feedback else 0
        if feedback and isinstance(feedback.get("score"), (int, float)):
            effective_score = float(feedback["score"])
            effective_level = level_for_score(effective_score)
            difficulty["score"] = effective_score
            difficulty["level"] = effective_level
            difficulty["source"] = "player-feedback"
            game["difficultyScore"] = effective_score
            game["difficultyLevel"] = effective_level
        override = overrides.get(appid)
        if not override:
            difficulty["manualScore"] = None
            difficulty["locked"] = False
            continue
        manual_score = override.get("manualScore")
        locked = bool(override.get("locked"))
        difficulty["manualScore"] = manual_score
        difficulty["locked"] = locked
        difficulty["overrideUpdatedAt"] = override.get("updatedAt")
        if locked and isinstance(manual_score, (int, float)):
            effective_score = float(manual_score)
            effective_level = level_for_score(effective_score)
            difficulty["score"] = effective_score
            difficulty["level"] = effective_level
            difficulty["source"] = "editorial-lock"
            game["difficultyScore"] = effective_score
            game["difficultyLevel"] = effective_level
    return games


def load_feedback_scores(db_path: Path | None) -> dict[int, dict[str, Any]]:
    if db_path is None or not db_path.exists():
        return {}
    connection = sqlite3.connect(db_path)
    try:
        exists = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'difficulty_feedback_scores'"
        ).fetchone()
        if not exists:
            return {}
        rows = connection.execute(
            """
            SELECT appid, current_score, status, sample_count
            FROM difficulty_feedback_scores
            WHERE current_score IS NOT NULL
            """
        ).fetchall()
    finally:
        connection.close()
    return {
        int(appid): {
            "score": float(score),
            "status": str(status),
            "sampleCount": int(sample_count),
        }
        for appid, score, status, sample_count in rows
    }


def load_review_redactions(
    db_path: Path | None,
) -> dict[tuple[int, str, str, str], str]:
    if db_path is None or not db_path.exists():
        return {}
    connection = sqlite3.connect(db_path)
    try:
        exists = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'review_redactions'"
        ).fetchone()
        if not exists:
            return {}
        rows = connection.execute(
            """
            SELECT appid, language, review_id, review_hash, redacted_text
            FROM review_redactions
            WHERE redacted_text <> ''
            ORDER BY imported_at
            """
        ).fetchall()
    finally:
        connection.close()
    return {
        (int(appid), str(language), str(review_id), str(review_hash)): str(text)
        for appid, language, review_id, review_hash, text in rows
    }

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
    cached_user_tags: dict[int, list[str]] | None = None,
    review_redactions: dict[tuple[int, str, str, str], str] | None = None,
) -> dict[str, dict[str, Any]]:
    """Materialize every row already admitted to Search.

    PICS ``type`` is retained as metadata but is not a publication authority:
    valid games can carry values such as Tool, Config, or advertising. Software
    and noise are hidden earlier through editorial exclusions or explicit AI
    ``eligible=false`` decisions.
    """
    previous = {int(game["appId"]): game for game in values(playable_payload) if game.get("appId")}
    result: dict[str, dict[str, Any]] = {}
    for source in catalog["games"]:
        appid = int(source["appId"])
        result[str(appid)] = build_game(
            source,
            previous.get(appid, {}),
            (cached_user_tags or {}).get(appid),
            review_redactions,
        )
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
    parser.add_argument("--active-limit", type=int, default=0, help="Publish only the first N catalog rows; 0 means all")
    args = parser.parse_args()

    catalog = json.loads(Path(args.catalog).read_text(encoding="utf-8"))
    playable_path = Path(args.playable)
    playable_payload = json.loads(playable_path.read_text(encoding="utf-8")) if playable_path.exists() else {}
    db_path = Path(args.db) if args.db else None
    excluded_appids = load_catalog_exclusions(db_path)
    ai_candidates = load_ai_candidates(db_path)
    catalog = select_publishable_catalog(catalog, excluded_appids, ai_candidates, args.active_limit)
    cached_user_tags = load_cached_user_tags(db_path)
    review_redactions = load_review_redactions(db_path)
    feedback_scores = load_feedback_scores(db_path)
    difficulty_overrides = load_difficulty_overrides(db_path)
    published = build_playable_catalog(
        catalog,
        playable_payload,
        cached_user_tags,
        review_redactions,
    )
    published = apply_effective_difficulties(
        published,
        ai_candidates,
        difficulty_overrides,
        feedback_scores,
    )

    out = Path(args.out)
    out.write_text(json.dumps(published, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    screenshots = sum(bool(game.get("hints", {}).get("screenshotUrls")) for game in published.values())
    reviews = sum(bool(game.get("hints", {}).get("reviewTexts")) for game in published.values())
    localized = sum(bool(game.get("localizedNames", {}).get("zh")) for game in published.values())
    cn_prices = sum("regular" in game.get("price", {}).get("cn", {}) for game in published.values())
    levels = ("beginner", "easy", "normal", "hard", "hell")
    counts = {level: sum(game.get("difficulty", {}).get("level") == level for game in published.values()) for level in levels}
    tagged = sum(bool(game.get("tags", {}).get("userTags")) for game in published.values())
    difficulty_sources: dict[str, int] = {}
    for game in published.values():
        source = str(game.get("difficulty", {}).get("source") or "missing")
        difficulty_sources[source] = difficulty_sources.get(source, 0) + 1
    print(
        f"selected={len(catalog['games'])} published={len(published)} "
        f"localized={localized} cn_prices={cn_prices} screenshots={screenshots} "
        f"reviews={reviews} tagged={tagged} difficulty={counts} "
        f"difficulty_sources={difficulty_sources} out={out}"
    )


if __name__ == "__main__":
    main()
