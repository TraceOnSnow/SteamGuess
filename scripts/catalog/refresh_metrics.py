#!/usr/bin/env python3
"""Sample SteamSpy's previous-day peak CCU and derive a rolling 7-day peak.

SteamSpy's ``ccu`` value is not live concurrency. It represents the peak CCU
for the previous day. Run this lightweight two-page sampler daily; the larger
metadata/localization pipeline can remain weekly.
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any

from scripts.catalog.discover_steamspy import as_int, fetch_page, utc_now


def game_values(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if isinstance(payload, dict):
        return [row for row in payload.values() if isinstance(row, dict)]
    raise ValueError("Game data must be an array or object")


def collect_sample(pages: list[dict[str, Any]]) -> dict[str, int]:
    sample: dict[str, int] = {}
    for payload in pages:
        for key, row in payload.items():
            if not isinstance(row, dict):
                continue
            appid = as_int(row.get("appid") or key)
            if appid:
                sample[str(appid)] = max(sample.get(str(appid), 0), as_int(row.get("ccu")))
    return sample


def retained_days(days: dict[str, Any], today: date, keep_days: int) -> dict[str, dict[str, int]]:
    cutoff = today - timedelta(days=max(1, keep_days) - 1)
    retained: dict[str, dict[str, int]] = {}
    for day, values in days.items():
        try:
            parsed = date.fromisoformat(day)
        except (TypeError, ValueError):
            continue
        if cutoff <= parsed <= today and isinstance(values, dict):
            retained[day] = {str(appid): as_int(value) for appid, value in values.items()}
    return dict(sorted(retained.items()))


def rolling_metrics(days: dict[str, dict[str, int]], today: date, window_days: int = 7) -> dict[str, dict[str, int]]:
    cutoff = today - timedelta(days=max(1, window_days) - 1)
    result: dict[str, dict[str, int]] = {}
    for day, values in days.items():
        parsed = date.fromisoformat(day)
        if not cutoff <= parsed <= today:
            continue
        for appid, value in values.items():
            metric = result.setdefault(str(appid), {"peak7d": 0, "peak7dSamples": 0})
            metric["peak7d"] = max(metric["peak7d"], as_int(value))
            metric["peak7dSamples"] += 1
    return result


def update_catalog(payload: Any, current_sample: dict[str, int], rolling: dict[str, dict[str, int]]) -> int:
    games = payload.get("games", []) if isinstance(payload, dict) and isinstance(payload.get("games"), list) else game_values(payload)
    updated = 0
    for game in games:
        appid = str(as_int(game.get("appId") or game.get("appid")))
        if appid == "0":
            continue
        target = game.setdefault("metrics", {}) if "metrics" in game or "games" in payload else game.setdefault("popularity", {})
        if appid in current_sample:
            target["peakYesterday"] = current_sample[appid]
            # Keep the legacy field synchronized for older clients.
            target["ccu"] = current_sample[appid]
        if appid in rolling:
            target.update(rolling[appid])
            updated += 1
    return updated


def write_json_atomic(path: Path, payload: Any, *, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    kwargs = {"ensure_ascii": False}
    if compact:
        kwargs["separators"] = (",", ":")
    else:
        kwargs["indent"] = 2
    with NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        json.dump(payload, handle, **kwargs)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pages", default="0,1")
    parser.add_argument("--history", default="data/metrics/player_peaks.json")
    parser.add_argument("--catalog", default="data/catalog/steamspy_top_2000.json")
    parser.add_argument("--playable", default="public/games_demo.json")
    parser.add_argument("--keep-days", type=int, default=14)
    parser.add_argument("--interval", type=float, default=65, help="Delay between SteamSpy request=all calls")
    parser.add_argument("--timeout", type=int, default=45)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--date", help="UTC sample date (YYYY-MM-DD); defaults to today")
    args = parser.parse_args()

    today = date.fromisoformat(args.date) if args.date else datetime.now(timezone.utc).date()
    page_numbers = [int(value.strip()) for value in args.pages.split(",") if value.strip()]
    payloads: list[dict[str, Any]] = []
    for index, page in enumerate(page_numbers):
        if index and args.interval > 0:
            time.sleep(args.interval)
        payload, transport = fetch_page(page, args.timeout, args.retries)
        payloads.append(payload)
        print(f"page={page} rows={len(payload)} transport={transport}")

    sample = collect_sample(payloads)
    history_path = Path(args.history)
    if history_path.exists():
        history = json.loads(history_path.read_text(encoding="utf-8"))
    else:
        history = {"schemaVersion": 1, "days": {}}
    days = retained_days(history.get("days", {}), today, args.keep_days)
    days[today.isoformat()] = sample
    days = retained_days(days, today, args.keep_days)
    rolling = rolling_metrics(days, today)
    history = {"schemaVersion": 1, "updatedAt": utc_now(), "days": days}
    write_json_atomic(history_path, history, compact=True)

    updates = []
    for path_string in (args.catalog, args.playable):
        path = Path(path_string)
        if not path.exists():
            continue
        payload = json.loads(path.read_text(encoding="utf-8"))
        count = update_catalog(payload, sample, rolling)
        write_json_atomic(path, payload, compact=path.name == "games_demo.json")
        updates.append(f"{path}={count}")

    print(f"sampled={len(sample)} rolling={len(rolling)} history_days={len(days)} {' '.join(updates)}")


if __name__ == "__main__":
    main()
