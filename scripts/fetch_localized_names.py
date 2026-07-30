#!/usr/bin/env python3
"""Enrich the normalized catalog with localized Steam Store names.

Steam tags can be translated through tagdata, but localized game titles are
per-app metadata. This script fetches exact App IDs from Store appdetails and
stores the result in ``localizedNames`` so the static frontend can search it.
The output is written incrementally and can be resumed safely.
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
LANGUAGE_KEYS = {"schinese": "zh"}


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


def extract_localized_name(payload: Any, appid: int) -> str | None:
    entry = payload.get(str(appid)) if isinstance(payload, dict) else None
    if not isinstance(entry, dict) or entry.get("success") is not True:
        return None
    data = entry.get("data")
    name = data.get("name") if isinstance(data, dict) else None
    return str(name).strip() if name else None


def fetch_name(appid: int, language: str, country: str, timeout: float) -> str | None:
    query = urlencode({"appids": appid, "l": language, "cc": country})
    request = Request(
        f"{STORE_ENDPOINT}?{query}",
        headers={"User-Agent": "SteamGuess catalog localization/1.0"},
    )
    with urlopen(request, timeout=timeout) as response:
        return extract_localized_name(json.load(response), appid)


def write_json(path: Path, payload: Any) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", default="data/catalog/steamspy_top_2000.json")
    parser.add_argument("--appids-from", default="public/games_demo.json", help="Only fetch App IDs present in this file")
    parser.add_argument("--out", default="data/catalog/steamspy_top_2000.json")
    parser.add_argument("--language", default="schinese")
    parser.add_argument("--country", default="cn")
    parser.add_argument("--delay", type=float, default=1.0)
    parser.add_argument("--timeout", type=float, default=15)
    parser.add_argument("--limit", type=int, default=0, help="Maximum requests; 0 means all missing names")
    parser.add_argument("--checkpoint", type=int, default=25)
    parser.add_argument("--max-consecutive-rate-limits", type=int, default=3)
    args = parser.parse_args()

    language_key = LANGUAGE_KEYS.get(args.language)
    if not language_key:
        raise ValueError(f"No frontend key configured for language: {args.language}")

    catalog_path = Path(args.catalog)
    output_path = Path(args.out)
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    games = payload_values(catalog)
    selected = set(load_app_ids(Path(args.appids_from))) if args.appids_from else {int(game["appId"]) for game in games}
    pending = [
        game for game in games
        if int(game["appId"]) in selected and not str(game.get("localizedNames", {}).get(language_key, "")).strip()
    ]
    if args.limit > 0:
        pending = pending[:args.limit]

    fetched = failed = consecutive_rate_limits = 0
    try:
        for index, game in enumerate(pending, start=1):
            appid = int(game["appId"])
            try:
                name = fetch_name(appid, args.language, args.country, args.timeout)
                if name:
                    game.setdefault("localizedNames", {})[language_key] = name
                    game.setdefault("fieldSources", {})["localizedNames"] = "storefront"
                    game.setdefault("sources", []).append({
                        "service": "storefront",
                        "endpoint": f"appdetails?l={args.language}&cc={args.country}",
                        "retrievedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                    })
                    fetched += 1
                    consecutive_rate_limits = 0
                    print(f"[{index}/{len(pending)}] {appid}: {name}", flush=True)
                else:
                    failed += 1
                    consecutive_rate_limits = 0
                    print(f"[{index}/{len(pending)}] {appid}: unavailable", flush=True)
            except HTTPError as error:
                failed += 1
                if error.code == 429:
                    consecutive_rate_limits += 1
                else:
                    consecutive_rate_limits = 0
                print(f"[{index}/{len(pending)}] {appid}: {error}", flush=True)
            except (URLError, TimeoutError, json.JSONDecodeError) as error:
                failed += 1
                consecutive_rate_limits = 0
                print(f"[{index}/{len(pending)}] {appid}: {error}", flush=True)
            if index % max(1, args.checkpoint) == 0:
                write_json(output_path, catalog)
            if consecutive_rate_limits >= max(1, args.max_consecutive_rate_limits):
                print("Steam Store rate limit persisted; stopping safely. Run the same command later to resume.", flush=True)
                break
            if index < len(pending):
                time.sleep(max(0, args.delay))
    finally:
        write_json(output_path, catalog)
    print(f"requested={len(pending)} localized={fetched} failed={failed} out={output_path}")


if __name__ == "__main__":
    main()
