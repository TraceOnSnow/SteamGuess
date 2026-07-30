#!/usr/bin/env python3
"""Fetch two SteamSpy `request=all` pages and build a normalized candidate catalog."""

from __future__ import annotations

import argparse
import json
import math
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

API = "https://steamspy.com/api.php?request=all&page={page}"
JINA_FALLBACK = "https://r.jina.ai/http://steamspy.com/api.php?request=all%26page={page}"
OBVIOUS_NON_GAME = re.compile(
    r"(?:\bdedicated server\b|\bserver tool\b|\bsoundtrack\b|\bplaytest\b|\bbenchmark\b)",
    re.IGNORECASE,
)
LEVELS = ("easy", "normal", "hard", "hell")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def as_int(value: Any) -> int:
    try:
        return max(0, int(float(value or 0)))
    except (TypeError, ValueError):
        return 0


def parse_owners(value: Any) -> tuple[int, int]:
    numbers = re.findall(r"[\d,]+", str(value or ""))
    parsed = [int(number.replace(",", "")) for number in numbers]
    if len(parsed) >= 2:
        return min(parsed[0], parsed[1]), max(parsed[0], parsed[1])
    if len(parsed) == 1:
        return parsed[0], parsed[0]
    return 0, 0


def decode_payload(body: str) -> dict[str, Any]:
    """Decode direct JSON or the Markdown wrapper returned by the read-only fallback."""
    stripped = body.strip()
    if not stripped.startswith("{"):
        marker = "Markdown Content:"
        if marker not in stripped:
            raise ValueError("Response contains neither JSON nor a Markdown Content section")
        stripped = stripped.split(marker, 1)[1].strip()
    payload = json.loads(stripped)
    if not isinstance(payload, dict):
        raise ValueError("SteamSpy response is not an object")
    return payload


def fetch_page(page: int, timeout: int, retries: int) -> tuple[dict[str, Any], str]:
    endpoints = ((API.format(page=page), "direct"), (JINA_FALLBACK.format(page=page), "r.jina.ai"))
    errors = []
    for url, transport in endpoints:
        request = Request(url, headers={"User-Agent": "SteamGuess-data-pipeline/1"})
        for attempt in range(retries + 1):
            try:
                with urlopen(request, timeout=timeout) as response:
                    payload = decode_payload(response.read().decode("utf-8"))
                return payload, transport
            except Exception as error:  # network errors vary by Python version
                errors.append(f"{transport}: {error}")
                if attempt < retries:
                    time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"SteamSpy page {page} failed: {'; '.join(errors)}")


def percentile(values: list[float], value: float) -> float:
    """Return a stable 0..1 empirical percentile, handling ties by upper rank."""
    if not values:
        return 0.0
    ordered = sorted(values)
    lo, hi = 0, len(ordered)
    while lo < hi:
        mid = (lo + hi) // 2
        if ordered[mid] <= value:
            lo = mid + 1
        else:
            hi = mid
    return lo / len(ordered)


def raw_features(row: dict[str, Any]) -> dict[str, float]:
    owners_min, owners_max = parse_owners(row.get("owners"))
    owners_mid = (owners_min + owners_max) / 2
    positive = as_int(row.get("positive"))
    negative = as_int(row.get("negative"))
    reviews = positive + negative
    return {
        "owners": math.log1p(owners_mid),
        "ccu": math.log1p(as_int(row.get("ccu"))),
        "reviews": math.log1p(reviews),
        "playtime": math.log1p(as_int(row.get("average_forever"))),
        "positiveRatio": positive / reviews if reviews else 0.0,
    }


def recognition_scores(rows: list[dict[str, Any]]) -> list[tuple[float, dict[str, float]]]:
    features = [raw_features(row) for row in rows]
    columns = {key: [item[key] for item in features] for key in features[0]} if features else {}
    weights = {
        "owners": 0.35,
        "ccu": 0.25,
        "reviews": 0.25,
        "playtime": 0.10,
        "positiveRatio": 0.05,
    }
    result = []
    for item in features:
        ranked = {key: percentile(columns[key], value) for key, value in item.items()}
        score = 100 * sum(weights[key] * ranked[key] for key in weights)
        result.append((round(score, 3), {key: round(value, 6) for key, value in ranked.items()}))
    return result


def level_from_rank(index: int, total: int) -> str:
    fraction = index / max(total, 1)
    if fraction < 0.20:
        return "easy"
    if fraction < 0.50:
        return "normal"
    if fraction < 0.80:
        return "hard"
    return "hell"


def normalize(raw_pages: list[tuple[int, dict[str, Any], str, str]]) -> dict[str, Any]:
    seen: set[int] = set()
    candidates: list[tuple[dict[str, Any], int, str]] = []
    rejected: list[dict[str, Any]] = []

    for page, payload, retrieved_at, transport in raw_pages:
        for key, row in payload.items():
            if not isinstance(row, dict):
                continue
            appid = as_int(row.get("appid") or key)
            name = str(row.get("name") or "").strip()
            reason = ""
            if not appid:
                reason = "invalid_appid"
            elif appid in seen:
                reason = "duplicate_appid"
            elif not name:
                reason = "missing_name"
            elif OBVIOUS_NON_GAME.search(name):
                reason = "obvious_non_game_name"
            if reason:
                rejected.append({"appId": appid, "name": name, "reason": reason})
                continue
            seen.add(appid)
            candidates.append((row, page, retrieved_at, transport))

    rows = [item[0] for item in candidates]
    scores = recognition_scores(rows)
    sortable = []
    for candidate, scored in zip(candidates, scores, strict=True):
        row, page, retrieved_at, transport = candidate
        recognition, features = scored
        sortable.append((recognition, row, page, retrieved_at, transport, features))
    sortable.sort(key=lambda item: (-item[0], as_int(item[1].get("appid"))))

    games = []
    for index, (recognition, row, page, retrieved_at, transport, features) in enumerate(sortable):
        appid = as_int(row.get("appid"))
        positive = as_int(row.get("positive"))
        negative = as_int(row.get("negative"))
        owners_min, owners_max = parse_owners(row.get("owners"))
        difficulty = round(100 - recognition, 3)
        games.append({
            "appId": appid,
            "name": str(row.get("name") or "").strip(),
            "type": None,
            "releaseDate": None,
            "developers": [str(row["developer"]).strip()] if row.get("developer") else [],
            "publishers": [str(row["publisher"]).strip()] if row.get("publisher") else [],
            "tags": [],
            "metrics": {
                # SteamSpy documents ccu as the previous day's peak, not a live count.
                "ccu": as_int(row.get("ccu")),
                "peakYesterday": as_int(row.get("ccu")),
                "ownersMin": owners_min,
                "ownersMax": owners_max,
                "positive": positive,
                "negative": negative,
                "reviewsTotal": positive + negative,
                "averageForeverMinutes": as_int(row.get("average_forever")),
                "averageTwoWeeksMinutes": as_int(row.get("average_2weeks")),
                "medianForeverMinutes": as_int(row.get("median_forever")),
                "medianTwoWeeksMinutes": as_int(row.get("median_2weeks")),
                "scoreRank": str(row.get("score_rank") or ""),
                "priceCents": as_int(row.get("price")),
                "initialPriceCents": as_int(row.get("initialprice")),
                "discountPercent": as_int(row.get("discount")),
            },
            "recognition": {"score": recognition, "features": features},
            "difficulty": {
                "score": difficulty,
                "level": level_from_rank(index, len(sortable)),
                "source": "heuristic",
                "excluded": False,
                "manualLevel": None,
            },
            "sources": [{
                "service": "steamspy",
                "endpoint": f"request=all&page={page}",
                "retrievedAt": retrieved_at,
                "transport": transport,
            }],
            "fieldSources": {
                "identity": "steamspy",
                "developers": "steamspy",
                "publishers": "steamspy",
                "metrics": "steamspy",
                "recognition": "derived:steamspy",
                "difficulty": "derived:heuristic-v1",
            },
        })

    level_counts = {level: sum(game["difficulty"]["level"] == level for game in games) for level in LEVELS}
    return {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "model": {
            "name": "popularity-percentile-heuristic",
            "version": "heuristic-v1",
            "weights": {"owners": 0.35, "ccu": 0.25, "reviews": 0.25, "playtime": 0.10, "positiveRatio": 0.05},
            "note": "Temporary baseline until manual labels are available for linear regression.",
        },
        "stats": {
            "rawRows": sum(len(payload) for _, payload, _, _ in raw_pages),
            "accepted": len(games),
            "rejected": len(rejected),
            "levelCounts": level_counts,
            "rejectionReasons": {reason: sum(row["reason"] == reason for row in rejected) for reason in sorted({r["reason"] for r in rejected})},
        },
        "rejected": rejected,
        "games": games,
    }



def preserve_enrichment(catalog: dict[str, Any], previous: dict[str, Any]) -> None:
    """Carry forward slower-changing enrichment when refreshing SteamSpy rows."""
    old_games = {int(game["appId"]): game for game in previous.get("games", []) if game.get("appId")}
    for game in catalog.get("games", []):
        old = old_games.get(int(game["appId"]))
        if not old:
            continue
        for field in ("localizedNames", "type", "picsChangeNumber", "tags"):
            if old.get(field) not in (None, [], {}):
                game[field] = old[field]
        old_metrics = old.get("metrics", {})
        for field in ("peak7d", "peak7dSamples"):
            if field in old_metrics:
                game["metrics"][field] = old_metrics[field]
        preserved_sources = [
            source for source in old.get("sources", [])
            if source.get("service") != "steamspy"
        ]
        game["sources"].extend(preserved_sources)
        for field, source in old.get("fieldSources", {}).items():
            if field not in {"identity", "developers", "publishers", "metrics", "recognition", "difficulty"}:
                game["fieldSources"][field] = source

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pages", default="0,1", help="Comma-separated SteamSpy page numbers")
    parser.add_argument("--raw-dir", default="data/raw/steamspy")
    parser.add_argument("--out", default="data/catalog/steamspy_top_2000.json")
    parser.add_argument("--timeout", type=int, default=45)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--interval", type=float, default=65, help="Delay between request=all calls")
    parser.add_argument("--from-raw", action="store_true", help="Use newest matching raw page files instead of network")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    pages = [int(item.strip()) for item in args.pages.split(",") if item.strip()]
    raw_dir = Path(args.raw_dir)
    raw_dir.mkdir(parents=True, exist_ok=True)
    raw_pages = []

    for index, page in enumerate(pages):
        if args.from_raw:
            matches = sorted(raw_dir.glob(f"page_{page}_*.json"))
            if not matches:
                raise FileNotFoundError(f"No raw file for page {page} in {raw_dir}")
            path = matches[-1]
            envelope = json.loads(path.read_text(encoding="utf-8"))
            payload, retrieved_at = envelope["payload"], envelope["retrievedAt"]
            transport = envelope.get("transport", "unknown")
        else:
            if index and args.interval > 0:
                time.sleep(args.interval)
            retrieved_at = utc_now()
            payload, transport = fetch_page(page, args.timeout, args.retries)
            stamp = retrieved_at.replace("-", "").replace(":", "").replace("T", "_").replace("Z", "")
            path = raw_dir / f"page_{page}_{stamp}.json"
            path.write_text(json.dumps({"page": page, "retrievedAt": retrieved_at, "transport": transport, "payload": payload}, ensure_ascii=False), encoding="utf-8")
        print(f"page={page} rows={len(payload)} transport={transport} raw={path}")
        raw_pages.append((page, payload, retrieved_at, transport))

    out = Path(args.out)
    previous = json.loads(out.read_text(encoding="utf-8")) if out.exists() else None
    catalog = normalize(raw_pages)
    if isinstance(previous, dict):
        preserve_enrichment(catalog, previous)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(catalog["stats"], ensure_ascii=False, indent=2))
    print(f"catalog={out}")


if __name__ == "__main__":
    main()
