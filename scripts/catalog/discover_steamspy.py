#!/usr/bin/env python3
"""Fetch selected SteamSpy `request=all` pages and build a normalized candidate catalog."""

from __future__ import annotations

import argparse
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

from scripts.catalog.common import split_company_names

API = "https://steamspy.com/api.php?request=all&page={page}"
JINA_FALLBACK = "https://r.jina.ai/http://steamspy.com/api.php?request=all%26page%3D{page}"
OBVIOUS_NON_GAME = re.compile(
    r"(?:\bdedicated server\b|\bserver tool\b|\bsoundtrack\b|\bplaytest\b|\bbenchmark\b)",
    re.IGNORECASE,
)


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
    """Decode direct JSON and the JSON/Markdown wrappers used by proxies."""
    stripped = body.strip()
    marker = "Markdown Content:"
    if marker in stripped:
        stripped = stripped.split(marker, 1)[1].strip()
    try:
        payload = json.loads(stripped)
    except json.JSONDecodeError:
        # Some read-only proxies add a title or a fenced block around JSON.
        start, end = stripped.find("{"), stripped.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("Response contains no JSON object")
        payload = json.loads(stripped[start:end + 1])
    if not isinstance(payload, dict):
        raise ValueError("SteamSpy response is not an object")
    return payload


def fetch_page(page: int, timeout: int, retries: int, retry_delay: float = 30.0) -> tuple[dict[str, Any], str]:
    endpoints = ((API.format(page=page), "direct"), (JINA_FALLBACK.format(page=page), "r.jina.ai"))
    errors = []
    for url, transport in endpoints:
        request = Request(url, headers={
            "Accept": "application/json, text/plain;q=0.9, */*;q=0.1",
            "User-Agent": "SteamGuess-data-pipeline/1",
        })
        for attempt in range(retries + 1):
            try:
                with urlopen(request, timeout=timeout) as response:
                    payload = decode_payload(response.read().decode("utf-8"))
                return payload, transport
            except Exception as error:  # network errors vary by Python version
                errors.append(f"{transport}: {error}")
                if attempt < retries:
                    delay = retry_delay * (attempt + 1)
                    print(f"page={page} transport={transport} attempt={attempt + 1}/{retries} failed={error}; retrying in {delay:g}s", flush=True)
                    time.sleep(delay)
    raise RuntimeError(f"SteamSpy page {page} failed after all transports: {'; '.join(errors)}")


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

    games = []
    # SteamSpy request=all pages are already ranked. Preserve their page and
    # response order so an active limit means the literal SteamSpy Top N.
    for row, page, retrieved_at, transport in candidates:
        appid = as_int(row.get("appid"))
        positive = as_int(row.get("positive"))
        negative = as_int(row.get("negative"))
        owners_min, owners_max = parse_owners(row.get("owners"))
        games.append({
            "appId": appid,
            "name": str(row.get("name") or "").strip(),
            "type": None,
            "releaseDate": None,
            "developers": split_company_names(row.get("developer")),
            "publishers": split_company_names(row.get("publisher")),
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
            },
        })

    return {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "stats": {
            "rawRows": sum(len(payload) for _, payload, _, _ in raw_pages),
            "accepted": len(games),
            "rejected": len(rejected),
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
        for field in (
            "localizedNames", "type", "picsChangeNumber", "tags", "regionalPrices",
            "releaseDate", "headerImage", "screenshots", "reviews", "reviewFetchLimits",
        ):
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
            if field in {
                "localizedNames", "type", "picsChangeNumber", "tags",
                "regionalPrices", "releaseDate", "headerImage", "screenshots",
                "reviews", "reviewFetchLimits",
            }:
                game["fieldSources"][field] = source

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pages", default="0,1", help="Comma-separated SteamSpy page numbers")
    parser.add_argument("--raw-dir", default="data/raw/steamspy")
    parser.add_argument("--out", default="data/catalog/steamspy_top_2000.json")
    parser.add_argument(
        "--preserve-from",
        help=(
            "Optional enriched catalog used as the carry-forward source. "
            "Defaults to the existing --out file."
        ),
    )
    parser.add_argument("--timeout", type=int, default=45)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--retry-delay", type=float, default=30.0, help="Base delay between retries for a failed page")
    parser.add_argument("--interval", type=float, default=65, help="Delay between request=all calls")
    parser.add_argument("--from-raw", action="store_true", help="Use newest matching raw page files instead of network")
    parser.add_argument("--resume", action="store_true", help="Reuse raw page checkpoints already present in --raw-dir")
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
            existing = sorted(raw_dir.glob(f"page_{page}_*.json")) if args.resume else []
            if existing:
                path = existing[-1]
                envelope = json.loads(path.read_text(encoding="utf-8"))
                payload, retrieved_at = envelope["payload"], envelope["retrievedAt"]
                transport = envelope.get("transport", "checkpoint")
                print(f"page={page} resumed raw={path}", flush=True)
            else:
                if index and args.interval > 0:
                    time.sleep(args.interval)
                retrieved_at = utc_now()
                payload, transport = fetch_page(page, args.timeout, args.retries, args.retry_delay)
                stamp = retrieved_at.replace("-", "").replace(":", "").replace("T", "_").replace("Z", "")
                path = raw_dir / f"page_{page}_{stamp}.json"
                path.write_text(json.dumps({"page": page, "retrievedAt": retrieved_at, "transport": transport, "payload": payload}, ensure_ascii=False), encoding="utf-8")
        print(f"page={page} rows={len(payload)} transport={transport} raw={path}")
        raw_pages.append((page, payload, retrieved_at, transport))

    out = Path(args.out)
    previous_path = Path(args.preserve_from) if args.preserve_from else out
    previous = (
        json.loads(previous_path.read_text(encoding="utf-8"))
        if previous_path.exists()
        else None
    )
    catalog = normalize(raw_pages)
    if isinstance(previous, dict):
        preserve_enrichment(catalog, previous)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(catalog["stats"], ensure_ascii=False, indent=2))
    print(f"catalog={out}")


if __name__ == "__main__":
    main()
