# -*- coding: utf-8 -*-
"""
Fetch raw game payloads from Steam Store appdetails API.

Key points:
- Read appid list from local json (same format as before)
- Support selecting appids by start/end index
- Keep all fields except blacklisted field paths
- Output JSONL under data/raw/games/store with timestamp filename

Output line example:
{"7670": {"appId": 7670, "name": "BioShock™", "releaseDate": "2007-08-21", "payload": {...}}}
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlencode

from rich.progress import track

from fetch_common import (
  RateLimiter,
  apply_index_range,
  http_get_json,
  load_done_appids_from_jsonl,
  load_local_appids,
  log_error,
  log_info,
  log_warn,
  normalize_date,
  now_timestamp,
)


STORE_INTERVAL = 2.5
MAX_RETRIES = 2
TIMEOUT = 25

# Blacklist paths, relative to `payload` object. Dotted path format.
# Example: "data.detailed_description" means payload["data"]["detailed_description"] is removed.
FIELD_BLACKLIST: set[str] = {
  "data.detailed_description",
  "data.about_the_game",
  "data.short_description",
  "data.extended_description",
  "data.legal_notice",
}


def drop_blacklisted_fields(value: Any, blacklist: set[str], path_parts: tuple[str, ...] = ()) -> Any:
  current_path = ".".join(path_parts)
  if current_path and current_path in blacklist:
    return None

  if isinstance(value, dict):
    out: Dict[str, Any] = {}
    for key, child in value.items():
      child_value = drop_blacklisted_fields(child, blacklist, (*path_parts, str(key)))
      if child_value is not None:
        out[key] = child_value
    return out

  if isinstance(value, list):
    out_list: List[Any] = []
    for child in value:
      child_value = drop_blacklisted_fields(child, blacklist, path_parts)
      if child_value is not None:
        out_list.append(child_value)
    return out_list

  return value


def fetch_store_meta(appid: int, cc: str, limiter: RateLimiter, retries: int, timeout: int) -> Dict[str, Any]:
  params = urlencode({"appids": str(appid), "cc": cc, "l": "english"})
  url = f"https://store.steampowered.com/api/appdetails?{params}"
  payload = http_get_json(url, limiter=limiter, retries=retries, timeout=timeout, source_name="store")
  return payload if isinstance(payload, dict) else {}


def build_store_record(appid: int, cc: str, limiter: RateLimiter, retries: int, timeout: int) -> Optional[Dict[str, Any]]:
  store_all = fetch_store_meta(appid, cc, limiter, retries, timeout)
  store_one = store_all.get(str(appid), {}) if isinstance(store_all, dict) else {}

  if not isinstance(store_one, dict) or not store_one.get("success"):
    return None

  payload = drop_blacklisted_fields(store_one, FIELD_BLACKLIST)
  data = payload.get("data", {}) if isinstance(payload, dict) else {}

  name = ""
  if isinstance(data, dict):
    name = str(data.get("name") or "")

  release_raw = ""
  if isinstance(data, dict):
    release = data.get("release_date")
    if isinstance(release, dict):
      release_raw = str(release.get("date") or "")
    elif release is not None:
      release_raw = str(release)

  return {
    str(appid): {
      "appId": appid,
      "name": name,
      "releaseDate": normalize_date(release_raw),
      "payload": payload,
    }
  }


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser()
  parser.add_argument("--appid-list", type=str, default="data/processed/appids_db_20260225.json", help="Local appid list json path")
  parser.add_argument("--start-index", type=int, default=0, help="Start index (inclusive)")
  parser.add_argument("--end-index", type=int, default=-1, help="End index (exclusive), -1 means until end")
  parser.add_argument("--top-n", type=int, default=0, help="Optional cap after range slicing (0 means all)")
  parser.add_argument("--store-cc", type=str, default="us", help="Store country code")
  parser.add_argument("--interval", type=float, default=STORE_INTERVAL, help="Store API min interval seconds")
  parser.add_argument("--max-retries", type=int, default=MAX_RETRIES, help="Max retries per request")
  parser.add_argument("--timeout", type=int, default=TIMEOUT, help="HTTP timeout in seconds")
  parser.add_argument("--out", type=str, default="", help="Optional output path; if empty use data/raw/games/store/store_raw_<ts>.jsonl")
  parser.add_argument("--resume", action="store_true", help="Resume from existing output jsonl")
  return parser.parse_args()


def main() -> None:
  args = parse_args()

  if args.interval <= 0:
    raise ValueError("interval must be > 0")
  if args.max_retries <= 0:
    raise ValueError("max-retries must be > 0")
  if args.timeout <= 0:
    raise ValueError("timeout must be > 0")

  limiter = RateLimiter(args.interval)

  all_appids = load_local_appids(Path(args.appid_list))
  appids = apply_index_range(all_appids, args.start_index, args.end_index, args.top_n)

  default_out = Path(f"data/raw/games/store/store_raw_{now_timestamp()}.jsonl")
  out_path = Path(args.out) if args.out else default_out
  out_path.parent.mkdir(parents=True, exist_ok=True)

  done_appids: set[int] = set()
  if args.resume:
    done_appids = load_done_appids_from_jsonl(out_path)
    if done_appids:
      before = len(appids)
      appids = [appid for appid in appids if appid not in done_appids]
      log_info(f"Resume enabled: done={len(done_appids)}, pending={len(appids)}, removed={before - len(appids)}")

  write_mode = "a" if args.resume else "w"

  log_info(
    f"Store fetch start: appid_list={args.appid_list}, range=[{args.start_index}:{args.end_index}], "
    f"top_n={args.top_n}, store_cc={args.store_cc}, interval={args.interval}, retries={args.max_retries}, timeout={args.timeout}"
  )
  log_info(f"Loaded appids={len(all_appids)}, selected={len(appids)}, out={out_path}, mode={write_mode}")
  log_info(f"Store field blacklist ({len(FIELD_BLACKLIST)}): {sorted(FIELD_BLACKLIST)}")

  ok_count = 0
  skip_count = 0
  err_count = 0

  with out_path.open(write_mode, encoding="utf-8") as handle:
    for appid in track(appids, description="Fetching store data"):
      try:
        record = build_store_record(appid, args.store_cc, limiter, args.max_retries, args.timeout)
        if record is None:
          skip_count += 1
          log_warn(f"[SKIP] {appid} no successful store data")
          continue

        handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        ok_count += 1
      except Exception as exc:
        err_count += 1
        log_error(f"[ERR] {appid}: {exc}")

  log_info(f"Store fetch done -> {out_path}")
  log_info(f"Summary: ok={ok_count}, skip={skip_count}, err={err_count}")


if __name__ == "__main__":
  main()
