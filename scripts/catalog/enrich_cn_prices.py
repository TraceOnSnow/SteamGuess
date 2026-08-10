#!/usr/bin/env python3
"""Quickly enrich selected games with mainland-China Steam list prices.

This uses Store ``appdetails`` with ``filters=price_overview`` and batches App
IDs. It complements ``fetch_localized_names.py``: the latter gets the localized
title and price together per game; this script fills prices much faster but
cannot obtain titles or reliably distinguish free games from unavailable apps.
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

STORE_ENDPOINT = "https://store.steampowered.com/api/appdetails"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def payload_values(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict) and isinstance(payload.get("games"), list):
        return [item for item in payload["games"] if isinstance(item, dict)]
    if isinstance(payload, dict):
        return [item for item in payload.values() if isinstance(item, dict)]
    raise ValueError("Unsupported catalog shape")


def load_app_ids(path: Path) -> list[int]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return [int(game["appId"]) for game in payload_values(payload) if game.get("appId")]


def extract_cn_prices(payload: Any, appids: list[int], retrieved_at: str) -> dict[int, dict[str, Any]]:
    results: dict[int, dict[str, Any]] = {}
    if not isinstance(payload, dict):
        return results
    for appid in appids:
        entry = payload.get(str(appid))
        data = entry.get("data") if isinstance(entry, dict) and entry.get("success") is True else None
        price = data.get("price_overview") if isinstance(data, dict) else None
        if not isinstance(price, dict) or str(price.get("currency") or "").upper() != "CNY":
            continue
        initial = price.get("initial")
        final = price.get("final")
        if not isinstance(initial, int) or initial < 0:
            continue
        results[appid] = {
            "status": "available",
            "currency": "CNY",
            "regularCents": initial,
            "retrievedAt": retrieved_at,
        }
    return results


def fetch_batch(appids: list[int], timeout: float) -> Any:
    query = urlencode({
        "appids": ",".join(str(appid) for appid in appids),
        "cc": "cn",
        "l": "schinese",
        "filters": "price_overview",
    })
    request = Request(
        f"{STORE_ENDPOINT}?{query}",
        headers={"User-Agent": "SteamGuess CN price enrichment/1.0"},
    )
    with urlopen(request, timeout=timeout) as response:
        return json.load(response)


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def chunks(items: list[int], size: int):
    for start in range(0, len(items), size):
        yield items[start:start + size]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", default="data/catalog/steamspy_top_2000.json")
    parser.add_argument("--appids-from", default="public/games_demo.json")
    parser.add_argument("--out", default="data/catalog/steamspy_top_2000.json")
    parser.add_argument("--batch-size", type=int, default=50)
    parser.add_argument("--delay", type=float, default=2.0)
    parser.add_argument("--timeout", type=float, default=20)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--max-rate-limit-retries", type=int, default=3)
    parser.add_argument("--rate-limit-wait", type=float, default=120)
    args = parser.parse_args()
    if args.batch_size < 1:
        raise ValueError("--batch-size must be at least 1")

    catalog_path = Path(args.catalog)
    output_path = Path(args.out)
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    games = payload_values(catalog)
    selected = set(load_app_ids(Path(args.appids_from)))
    by_appid = {int(game["appId"]): game for game in games}
    pending = [
        appid for appid in selected
        if appid in by_appid
        and by_appid[appid].get("regionalPrices", {}).get("cn", {}).get("status") not in {"available", "free"}
    ]
    pending.sort()
    if args.limit > 0:
        pending = pending[:args.limit]

    batches = list(chunks(pending, args.batch_size))
    requests = priced = unresolved = 0
    try:
        for index, batch in enumerate(batches, start=1):
            if index > 1:
                time.sleep(args.delay)
            retries = 0
            while True:
                try:
                    requests += 1
                    payload = fetch_batch(batch, args.timeout)
                    break
                except HTTPError as error:
                    if error.code != 429 or retries >= args.max_rate_limit_retries:
                        raise
                    retries += 1
                    retry_after = error.headers.get("Retry-After") if error.headers else None
                    try:
                        wait = max(0.0, float(retry_after)) if retry_after else args.rate_limit_wait
                    except ValueError:
                        wait = args.rate_limit_wait
                    print(f"[{index}/{len(batches)}] rate limited; retry {retries} after {wait:.0f}s", flush=True)
                    time.sleep(wait)

            retrieved_at = utc_now()
            found = extract_cn_prices(payload, batch, retrieved_at)
            for appid, price in found.items():
                game = by_appid[appid]
                game.setdefault("regionalPrices", {})["cn"] = price
                game.setdefault("fieldSources", {})["regionalPrices.cn"] = "storefront"
            priced += len(found)
            unresolved += len(batch) - len(found)
            write_json(output_path, catalog)
            print(f"[{index}/{len(batches)}] priced={len(found)} unresolved={len(batch) - len(found)}", flush=True)
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as error:
        write_json(output_path, catalog)
        raise SystemExit(f"Stopped safely after {requests} requests: {error}") from error

    print(f"pending={len(pending)} requests={requests} priced={priced} unresolved={unresolved} out={output_path}")


if __name__ == "__main__":
    main()
