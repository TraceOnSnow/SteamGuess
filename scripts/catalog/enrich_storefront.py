#!/usr/bin/env python3
"""Enrich the catalog with Simplified Chinese names and mainland-China list prices.

A full Steam Store ``appdetails`` response contains both fields, so the normal
path uses one request per App ID. Progress is checkpointed and resumable.
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
DEFAULT_STATE_PATH = "data/processed/storefront_localized_names_schinese.json"


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
    if isinstance(payload, dict) and isinstance(payload.get("appIds"), list):
        return [int(value) for value in payload["appIds"]]
    return [int(game["appId"]) for game in payload_values(payload) if game.get("appId")]


def extract_storefront_details(payload: Any, appid: int) -> dict[str, Any] | None:
    entry = payload.get(str(appid)) if isinstance(payload, dict) else None
    if not isinstance(entry, dict) or entry.get("success") is not True:
        return None
    data = entry.get("data")
    if not isinstance(data, dict):
        return None

    name = str(data.get("name") or "").strip() or None
    is_free = data.get("is_free") is True
    price = data.get("price_overview")
    release_date = data.get("release_date")
    release_text = release_date.get("date") if isinstance(release_date, dict) else None
    result: dict[str, Any] = {
        "name": name,
        "isFree": is_free,
        "price": None,
        "type": str(data.get("type") or "").strip() or None,
        "releaseDate": str(release_text or "").strip() or None,
        "developers": [str(value).strip() for value in data.get("developers", []) if str(value).strip()],
        "publishers": [str(value).strip() for value in data.get("publishers", []) if str(value).strip()],
        "screenshots": [
            {
                "id": item.get("id"),
                "path": str(item.get("path_full") or item.get("path_thumbnail") or "").strip(),
                "pathThumbnail": str(item.get("path_thumbnail") or "").strip(),
            }
            for item in data.get("screenshots", [])
            if isinstance(item, dict) and (item.get("path_full") or item.get("path_thumbnail"))
        ],
        "headerImage": str(data.get("header_image") or "").strip() or None,
    }
    if isinstance(price, dict):
        initial = price.get("initial")
        final = price.get("final")
        if isinstance(initial, int) and initial >= 0:
            result["price"] = {
                "currency": str(price.get("currency") or "").upper(),
                "initialCents": initial,
                "finalCents": final if isinstance(final, int) and final >= 0 else initial,
                "discountPercent": int(price.get("discount_percent") or 0),
            }
    return result


def extract_localized_name(payload: Any, appid: int) -> str | None:
    """Backward-compatible helper retained for tests and script consumers."""
    details = extract_storefront_details(payload, appid)
    return details.get("name") if details else None


def fetch_details(appid: int, language: str, country: str, timeout: float) -> dict[str, Any] | None:
    query = urlencode({"appids": appid, "l": language, "cc": country})
    request = Request(
        f"{STORE_ENDPOINT}?{query}",
        headers={"User-Agent": "SteamGuess catalog localization/1.1"},
    )
    with urlopen(request, timeout=timeout) as response:
        return extract_storefront_details(json.load(response), appid)


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def load_state(path: Path, language: str) -> dict[str, Any]:
    if path.exists():
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, dict) and isinstance(payload.get("apps"), dict):
            return payload
    return {"language": language, "updatedAt": None, "apps": {}}


def add_source(game: dict[str, Any], language: str, country: str, retrieved_at: str) -> None:
    endpoint = f"appdetails?l={language}&cc={country}"
    sources = game.setdefault("sources", [])
    for source in sources:
        if isinstance(source, dict) and source.get("service") == "storefront" and source.get("endpoint") == endpoint:
            source["retrievedAt"] = retrieved_at
            return
    sources.append({"service": "storefront", "endpoint": endpoint, "retrievedAt": retrieved_at})


def regional_price_record(details: dict[str, Any], country: str, retrieved_at: str) -> dict[str, Any]:
    expected_currency = "CNY" if country.lower() == "cn" else None
    if details.get("isFree") is True:
        return {
            "status": "free",
            "currency": expected_currency or "",
            "regularCents": 0,
            "retrievedAt": retrieved_at,
        }

    price = details.get("price")
    if isinstance(price, dict) and (expected_currency is None or price.get("currency") == expected_currency):
        return {
            "status": "available",
            "currency": price.get("currency"),
            "regularCents": price.get("initialCents"),
            "retrievedAt": retrieved_at,
        }

    return {"status": "unavailable", "retrievedAt": retrieved_at}


def has_regional_price_status(game: dict[str, Any], country: str) -> bool:
    price = game.get("regionalPrices", {}).get(country.lower(), {})
    return isinstance(price, dict) and price.get("status") in {"available", "free", "unavailable"}


def retry_after_seconds(error: HTTPError, default: float) -> float:
    value = error.headers.get("Retry-After") if error.headers else None
    try:
        return max(0.0, float(value)) if value is not None else default
    except ValueError:
        return default


def save_progress(output_path: Path, catalog: Any, state_path: Path, state: dict[str, Any]) -> None:
    state["updatedAt"] = utc_now()
    write_json(output_path, catalog)
    write_json(state_path, state)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", default="data/catalog/steamspy_top_2000.json")
    parser.add_argument("--appids-from", default="public/games_demo.json", help="Only fetch App IDs present in this file")
    parser.add_argument("--out", default="data/catalog/steamspy_top_2000.json")
    parser.add_argument("--state", default=DEFAULT_STATE_PATH)
    parser.add_argument("--language", default="schinese")
    parser.add_argument("--country", default="cn")
    parser.add_argument("--fallback-country", default="us", help="Fallback used only when the primary response has no title")
    parser.add_argument("--delay", type=float, default=2.0, help="Minimum delay between Store requests")
    parser.add_argument("--timeout", type=float, default=15)
    parser.add_argument("--limit", type=int, default=0, help="Maximum App IDs; 0 means all pending entries")
    parser.add_argument("--checkpoint", type=int, default=25)
    parser.add_argument("--max-rate-limit-retries", type=int, default=3)
    parser.add_argument("--rate-limit-wait", type=float, default=120)
    args = parser.parse_args()

    language_key = LANGUAGE_KEYS.get(args.language)
    if not language_key:
        raise ValueError(f"No frontend key configured for language: {args.language}")

    catalog_path = Path(args.catalog)
    output_path = Path(args.out)
    state_path = Path(args.state)
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    games = payload_values(catalog)
    selected = set(load_app_ids(Path(args.appids_from))) if args.appids_from else {int(game["appId"]) for game in games}
    state = load_state(state_path, args.language)
    app_state = state["apps"]
    primary_country = args.country.lower()

    for game in games:
        appid = int(game["appId"])
        name = str(game.get("localizedNames", {}).get(language_key, "")).strip()
        if name and str(appid) not in app_state:
            app_state[str(appid)] = {"status": "success", "name": name, "retrievedAt": None}

    pending = []
    for game in games:
        appid = int(game["appId"])
        if appid not in selected:
            continue
        localized = game.get("localizedNames")
        missing_name = not str(localized.get(language_key, "") if isinstance(localized, dict) else "").strip()
        name_known_unavailable = app_state.get(str(appid), {}).get("status") == "unavailable"
        missing_price = not has_regional_price_status(game, primary_country)
        # A prior job can be marked complete while the current catalog snapshot
        # still lacks fields (for example after a fresh SteamSpy discovery).
        # ``type`` is required by publish_playable and must therefore be part of
        # the actual pending check, not inferred from the job table alone.
        missing_type = not str(game.get("type") or "").strip()
        if (missing_name and not name_known_unavailable) or missing_price or missing_type:
            pending.append(game)
    if args.limit > 0:
        pending = pending[:args.limit]

    countries = list(dict.fromkeys(country.lower() for country in (args.country, args.fallback_country) if country))
    localized = priced = unavailable = transient_failures = requests = 0
    last_request_at: float | None = None

    def wait_for_request_slot() -> None:
        nonlocal last_request_at
        if last_request_at is not None:
            time.sleep(max(0.0, args.delay - (time.monotonic() - last_request_at)))

    try:
        for index, game in enumerate(pending, start=1):
            appid = int(game["appId"])
            details_by_country: dict[str, dict[str, Any]] = {}
            last_error = None
            rate_limit_retries = 0

            for country in countries:
                while True:
                    wait_for_request_slot()
                    try:
                        last_request_at = time.monotonic()
                        requests += 1
                        details = fetch_details(appid, args.language, country, args.timeout)
                        if details:
                            details_by_country[country] = details
                        break
                    except HTTPError as error:
                        last_request_at = time.monotonic()
                        last_error = f"HTTP {error.code}: {error.reason}"
                        if error.code != 429 or rate_limit_retries >= max(0, args.max_rate_limit_retries):
                            break
                        rate_limit_retries += 1
                        wait = retry_after_seconds(error, args.rate_limit_wait)
                        print(
                            f"[{index}/{len(pending)}] {appid}: rate limited; retry "
                            f"{rate_limit_retries}/{args.max_rate_limit_retries} after {wait:.0f}s",
                            flush=True,
                        )
                        time.sleep(wait)
                    except (URLError, TimeoutError, json.JSONDecodeError) as error:
                        last_request_at = time.monotonic()
                        last_error = str(error)
                        break
                primary = details_by_country.get(primary_country)
                if last_error or (primary and primary.get("name")):
                    break

            retrieved_at = utc_now()
            primary = details_by_country.get(primary_country)
            any_details = primary or next(iter(details_by_country.values()), None)
            name = next((item.get("name") for item in details_by_country.values() if item.get("name")), None)

            if any_details:
                # Storefront appdetails is the authoritative rich metadata response.
                # Persist it even when the CN request is unavailable, using the first
                # successful country response as a fallback.
                if any_details.get("type"):
                    game["type"] = any_details["type"]
                    game.setdefault("fieldSources", {})["type"] = "storefront"
                if any_details.get("releaseDate"):
                    game["releaseDate"] = any_details["releaseDate"]
                    game.setdefault("fieldSources", {})["releaseDate"] = "storefront"
                for field in ("developers", "publishers"):
                    if any_details.get(field):
                        game[field] = any_details[field]
                        game.setdefault("fieldSources", {})[field] = "storefront"
                if any_details.get("headerImage"):
                    game["headerImage"] = any_details["headerImage"]
                screenshots = any_details.get("screenshots") or []
                if screenshots:
                    game["screenshots"] = screenshots
                    game.setdefault("hints", {})["screenshotUrl"] = screenshots[0].get("path")
                    game.setdefault("fieldSources", {})["screenshots"] = "storefront"

            if primary:
                price_record = regional_price_record(primary, primary_country, retrieved_at)
                game.setdefault("regionalPrices", {})[primary_country] = price_record
                game.setdefault("fieldSources", {})[f"regionalPrices.{primary_country}"] = "storefront"
                add_source(game, args.language, primary_country, retrieved_at)
                if price_record["status"] in {"available", "free"}:
                    priced += 1
            elif not last_error:
                game.setdefault("regionalPrices", {})[primary_country] = {
                    "status": "unavailable",
                    "retrievedAt": retrieved_at,
                }

            if name:
                game.setdefault("localizedNames", {})[language_key] = name
                game.setdefault("fieldSources", {})["localizedNames"] = "storefront"
                source_country = next(country for country, item in details_by_country.items() if item.get("name"))
                add_source(game, args.language, source_country, retrieved_at)
                localized += 1

            price_status = game.get("regionalPrices", {}).get(primary_country, {}).get("status")
            if name or any_details:
                app_state[str(appid)] = {
                    "status": "success",
                    "name": name,
                    "country": primary_country if primary else next(iter(details_by_country), None),
                    "priceStatus": price_status,
                    "retrievedAt": retrieved_at,
                }
                print(f"[{index}/{len(pending)}] {appid}: {name or 'no title'}; {primary_country} price={price_status}", flush=True)
            elif last_error:
                app_state[str(appid)] = {"status": "error", "lastError": last_error, "retrievedAt": retrieved_at}
                transient_failures += 1
                print(f"[{index}/{len(pending)}] {appid}: {last_error}; stopping safely", flush=True)
                break
            else:
                app_state[str(appid)] = {
                    "status": "unavailable",
                    "countries": countries,
                    "priceStatus": "unavailable",
                    "retrievedAt": retrieved_at,
                }
                unavailable += 1
                print(f"[{index}/{len(pending)}] {appid}: unavailable ({'/'.join(countries)})", flush=True)

            if index % max(1, args.checkpoint) == 0:
                save_progress(output_path, catalog, state_path, state)
    finally:
        save_progress(output_path, catalog, state_path, state)

    print(
        f"pending={len(pending)} requests={requests} localized={localized} priced={priced} "
        f"unavailable={unavailable} transient_failures={transient_failures} out={output_path} state={state_path}"
    )
    if transient_failures:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
