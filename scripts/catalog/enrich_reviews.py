#!/usr/bin/env python3
"""Fetch the bounded helpful-review snapshot for newly enriched active apps."""
from __future__ import annotations

import argparse
import http.client
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from typing import Any

ENDPOINT = "https://store.steampowered.com/appreviews/{appid}"
LANGUAGES = ("english", "schinese")
REVIEWS_PER_LANGUAGE = 100

def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

def fetch_reviews(appid: int, language: str, timeout: float = 30) -> list[dict[str, Any]]:
    query = urlencode({"json": 1, "language": language, "filter": "all", "day_range": 365, "num_per_page": REVIEWS_PER_LANGUAGE, "cursor": "*"})
    request = Request(ENDPOINT.format(appid=appid) + "?" + query, headers={"User-Agent": "SteamGuess review enrichment/1.0"})
    with urlopen(request, timeout=timeout) as response:
        payload = json.load(response)
    return normalize_reviews(payload, language, utc_now())

def normalize_reviews(payload: Any, language: str, retrieved_at: str) -> list[dict[str, Any]]:
    reviews = payload.get("reviews", []) if isinstance(payload, dict) else []
    result = []
    for item in reviews:
        if not isinstance(item, dict):
            continue
        text = str(item.get("review") or "").strip()
        if not text:
            continue
        result.append({
            "reviewId": str(item.get("recommendationid") or ""),
            "text": text,
            "votedUp": item.get("voted_up"),
            "votesUp": item.get("votes_up"),
            "votesFunny": item.get("votes_funny"),
            "weightedVoteScore": item.get("weighted_vote_score"),
            "timestampCreated": item.get("timestamp_created"),
            "timestampUpdated": item.get("timestamp_updated"),
            "source": "steamreviews",
            "language": language,
            "retrievedAt": retrieved_at,
        })
    return result[:REVIEWS_PER_LANGUAGE]

def save_checkpoint(path: Path, payload: Any) -> None:
    """Atomically persist progress so an interrupted run can be resumed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.reviews-tmp-{os.getpid()}")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def load_games(payload: Any) -> list[dict[str, Any]]:
    """Return game objects from the already-loaded catalog.

    Keeping these exact objects is important: mutating a second JSON load would
    enrich an in-memory copy and silently drop reviews when the catalog is saved.
    """
    games = payload.get("games", []) if isinstance(payload, dict) else payload
    return [game for game in games if isinstance(game, dict) and game.get("appId")]

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", default="data/catalog/steamspy_candidates.json")
    parser.add_argument("--appids", required=True, help="JSON file containing appId values to process")
    parser.add_argument("--out", default="data/catalog/steamspy_candidates.json")
    parser.add_argument("--delay", type=float, default=2.0)
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--retries", type=int, default=3, help="Retries after transient review request failures")
    parser.add_argument("--retry-delay", type=float, default=30.0, help="Seconds before retrying a failed review request")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--allow-failures", action="store_true", help="Return success even when some requests failed")
    args = parser.parse_args()
    catalog_path, out_path = Path(args.catalog), Path(args.out)
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    games = load_games(catalog)
    selected_payload = json.loads(Path(args.appids).read_text(encoding="utf-8"))
    selected = selected_payload.get("appIds", selected_payload) if isinstance(selected_payload, dict) else selected_payload
    selected_ids = {int(value) for value in selected}
    pending = [game for game in games if int(game["appId"]) in selected_ids]
    if args.limit > 0:
        pending = pending[:args.limit]
    if args.retries < 0:
        raise SystemExit("--retries must be non-negative")
    if args.retry_delay < 0:
        raise SystemExit("--retry-delay must be non-negative")

    counts = {language: 0 for language in LANGUAGES}
    cached = 0
    failures: list[dict[str, Any]] = []
    total = len(pending) * len(LANGUAGES)
    completed = 0
    for index, game in enumerate(pending, start=1):
        appid = int(game["appId"])
        game_reviews = game.setdefault("reviews", {})
        for language in LANGUAGES:
            completed += 1
            fetched_limits = game.setdefault("reviewFetchLimits", {})
            if language in game_reviews and int(fetched_limits.get(language, 0) or 0) >= REVIEWS_PER_LANGUAGE:
                cached += 1
                print(f"[{completed}/{total}] {appid}: {language} cached", flush=True)
                continue
            if completed > 1:
                time.sleep(max(0.0, args.delay))
            last_error: Exception | None = None
            for attempt in range(args.retries + 1):
                try:
                    items = fetch_reviews(appid, language, args.timeout)
                    game_reviews[language] = items
                    fetched_limits[language] = REVIEWS_PER_LANGUAGE
                    counts[language] += 1
                    save_checkpoint(out_path, catalog)
                    print(f"[{completed}/{total}] {appid}: {language} ok reviews={len(items)}", flush=True)
                    last_error = None
                    break
                except (HTTPError, URLError, TimeoutError, json.JSONDecodeError,
                        http.client.RemoteDisconnected, ConnectionResetError,
                        TimeoutError, OSError) as error:
                    last_error = error
                    if attempt < args.retries:
                        wait = max(0.0, args.retry_delay) * (attempt + 1)
                        print(f"[{completed}/{total}] {appid}: {language} failed ({attempt + 1}/{args.retries + 1}): {error}; retrying in {wait:g}s", flush=True)
                        time.sleep(wait)
            if last_error is not None:
                failures.append({"appId": appid, "language": language, "error": str(last_error)})
                print(f"[{completed}/{total}] {appid}: {language} failed permanently: {last_error}", flush=True)
                save_checkpoint(out_path, catalog)

    save_checkpoint(out_path, catalog)
    print(f"apps={len(pending)} " + " ".join(f"{key}={value}" for key, value in counts.items()) + f" cached={cached} failures={len(failures)} out={out_path}", flush=True)
    if failures:
        print("failed=" + json.dumps(failures, ensure_ascii=False), flush=True)
        if not args.allow_failures:
            raise SystemExit(2)

if __name__ == "__main__":
    main()
