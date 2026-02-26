# -*- coding: utf-8 -*-
"""
Fetch raw game payloads from SteamSpy appdetails API.

Key points:
- Read appid list from local json (same format as before)
- Support selecting appids by start/end index
- Keep SteamSpy payload fully (no pruning)
- Output JSONL under data/raw/games/spy with timestamp filename

Output line example:
{"7670": {"appId": 7670, "name": "BioShock", "releaseDate": "2007-08-21", "payload": {...}}}
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, Optional
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


STEAMSPY_INTERVAL = 3.0
MAX_RETRIES = 1
TIMEOUT = 25


def fetch_spy_details(appid: int, limiter: RateLimiter, retries: int, timeout: int) -> Dict[str, Any]:
  params = urlencode({"request": "appdetails", "appid": str(appid)})
  url = f"https://steamspy.com/api.php?{params}"
  payload = http_get_json(url, limiter=limiter, retries=retries, timeout=timeout, source_name="steamspy")
  return payload if isinstance(payload, dict) else {}


def build_spy_record(appid: int, limiter: RateLimiter, retries: int, timeout: int) -> Optional[Dict[str, Any]]:
  payload = fetch_spy_details(appid, limiter, retries, timeout)
  if not payload:
    return None

  name = str(payload.get("name") or "")
  release_raw = payload.get("release_date")

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
  parser.add_argument("--appid-list", type=str, default="data/processed/toplist_appids.json", help="Local appid list json path")
  parser.add_argument("--start-index", type=int, default=0, help="Start index (inclusive)")
  parser.add_argument("--end-index", type=int, default=-1, help="End index (exclusive), -1 means until end")
  parser.add_argument("--top-n", type=int, default=0, help="Optional cap after range slicing (0 means all)")
  parser.add_argument("--interval", type=float, default=STEAMSPY_INTERVAL, help="SteamSpy API min interval seconds")
  parser.add_argument("--max-retries", type=int, default=MAX_RETRIES, help="Max retries per request")
  parser.add_argument("--timeout", type=int, default=TIMEOUT, help="HTTP timeout in seconds")
  parser.add_argument("--out", type=str, default="", help="Optional output path; if empty use data/raw/games/spy/spy_raw_<ts>.jsonl")
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

  default_out = Path(f"data/raw/games/spy/spy_raw_{now_timestamp()}.jsonl")
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
    f"SteamSpy fetch start: appid_list={args.appid_list}, range=[{args.start_index}:{args.end_index}], "
    f"top_n={args.top_n}, interval={args.interval}, retries={args.max_retries}, timeout={args.timeout}"
  )
  log_info(f"Loaded appids={len(all_appids)}, selected={len(appids)}, out={out_path}, mode={write_mode}")

  ok_count = 0
  skip_count = 0
  err_count = 0

  with out_path.open(write_mode, encoding="utf-8") as handle:
    for appid in track(appids, description="Fetching steamspy data"):
      try:
        record = build_spy_record(appid, limiter, args.max_retries, args.timeout)
        if record is None:
          skip_count += 1
          log_warn(f"[SKIP] {appid} empty steamspy payload")
          continue

        handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        ok_count += 1
      except Exception as exc:
        err_count += 1
        log_error(f"[ERR] {appid}: {exc}")

  log_info(f"SteamSpy fetch done -> {out_path}")
  log_info(f"Summary: ok={ok_count}, skip={skip_count}, err={err_count}")


if __name__ == "__main__":
  main()
