# -*- coding: utf-8 -*-
"""
SteamGuess raw data fetcher
- Read appid list from local normalized toplist JSON
- Fetch per-app details from Steam Store appdetails + SteamSpy appdetails
- Keep SteamSpy payload as-is
- Prune only overlong fields from Steam Store payload
- Output JSONL (one game per line)
"""

from __future__ import annotations
import argparse
import json
import random
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlencode, urlparse, parse_qs
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from json import JSONDecodeError
from rich import print as rprint
from rich.progress import track


USER_AGENT = "SteamGuessDataBot/0.1 (+https://example.local)"
STORE_INTERVAL = 2.5
STEAMSPY_INTERVAL = 2.0
STEAMSPY_ALL_INTERVAL = 60.1
MAX_RETRIES = 2
MAX_STORE_STRING_LENGTH = 600
MAX_STORE_LIST_LENGTH = 200
RETRY_LIMIT = MAX_RETRIES


def log_info(message: str) -> None:
  rprint(f"[cyan][INFO][/cyan] {message}")


def log_warn(message: str) -> None:
  rprint(f"[yellow][WARN][/yellow] {message}")


def log_error(message: str) -> None:
  rprint(f"[red][ERROR][/red] {message}")


@dataclass
class RateLimiter:
  min_interval: float
  _last_ts: float = 0.0

  def wait(self) -> float:
    now = time.monotonic()
    delta = now - self._last_ts
    waited = 0.0
    if delta < self.min_interval:
      waited = self.min_interval - delta
      time.sleep(waited)
    self._last_ts = time.monotonic()
    return waited


store_limiter = RateLimiter(STORE_INTERVAL)
steamspy_limiter = RateLimiter(STEAMSPY_INTERVAL)
steamspy_all_limiter = RateLimiter(STEAMSPY_ALL_INTERVAL)


def choose_limiter(url: str) -> tuple[str, RateLimiter]:
  parsed = urlparse(url)
  host = parsed.netloc.lower()

  if "steamspy.com" in host:
    request_param = parse_qs(parsed.query).get("request", [""])[0].lower()
    if request_param == "all":
      return "steamspy:all", steamspy_all_limiter
    return "steamspy:normal", steamspy_limiter

  if "store.steampowered.com" in host:
    return "store", store_limiter

  return "default", steamspy_limiter


def http_get_json(url: str, timeout: int = 25) -> Any:
  backoff = 1.0
  for attempt in range(RETRY_LIMIT):
    source_name, limiter = choose_limiter(url)
    waited = limiter.wait()
    if waited > 0:
      log_info(f"Rate limited by {source_name}, slept {waited:.2f}s")

    log_info(f"HTTP GET attempt {attempt + 1}/{RETRY_LIMIT} -> {url}")
    req = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
      with urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8", errors="replace")
        try:
          log_info(f"HTTP OK ({source_name}), payload size={len(body)}")
          return json.loads(body)
        except JSONDecodeError:
          sleep_for = backoff + random.random() * 0.5
          if "Too many connections" in body:
            sleep_for = max(sleep_for, 5.0 + random.random() * 2.0)
          log_warn(f"Non-JSON response ({source_name}) attempt {attempt + 1}/{RETRY_LIMIT}")
          log_warn(f"Body head: {body[:120]!r}")
          log_warn(f"Backoff sleep {sleep_for:.2f}s")
          time.sleep(sleep_for)
          backoff *= 2
          continue
    except HTTPError as e:
      if e.code in (429, 500, 502, 503, 504):
        sleep_for = backoff + random.random() * 0.5
        log_warn(f"HTTP {e.code} ({source_name}) attempt {attempt + 1}/{RETRY_LIMIT}, sleep {sleep_for:.2f}s")
        time.sleep(sleep_for)
        backoff *= 2
        continue
      log_error(f"HTTPError {e.code} ({source_name}) -> {url}")
      raise
    except URLError:
      sleep_for = backoff + random.random() * 0.5
      log_warn(f"URLError ({source_name}) attempt {attempt + 1}/{RETRY_LIMIT}, sleep {sleep_for:.2f}s")
      time.sleep(sleep_for)
      backoff *= 2
  raise RuntimeError(f"Failed after retries ({RETRY_LIMIT}): {url}")


def load_local_appids(path: Path, top_n: int) -> List[int]:
  if not path.exists():
    raise FileNotFoundError(f"appid list file not found: {path}")

  data = json.loads(path.read_text(encoding="utf-8"))
  appids: List[int] = []

  if isinstance(data, dict) and isinstance(data.get("appids"), list):
    source = data.get("appids", [])
  elif isinstance(data, list):
    source = data
  else:
    raise ValueError("appid list file must be {'appids': [...]} or a plain list")

  for item in source:
    try:
      appids.append(int(item))
    except Exception:
      continue

  if top_n > 0:
    appids = appids[:top_n]
  return appids


def fetch_store_meta(appid: int, cc: str = "us") -> Dict[str, Any]:
  params = urlencode({
    "appids": str(appid),
    "cc": cc,
    "l": "english",
  })
  url = f"https://store.steampowered.com/api/appdetails?{params}"
  return http_get_json(url)


def fetch_spy_details(appid: int) -> Dict[str, Any]:
  params = urlencode({"request": "appdetails", "appid": str(appid)})
  url = f"https://steamspy.com/api.php?{params}"
  return http_get_json(url)


def prune_store_payload(value: Any) -> Any:
  if isinstance(value, dict):
    pruned: Dict[str, Any] = {}
    for k, v in value.items():
      cleaned = prune_store_payload(v)
      if cleaned is not None:
        pruned[k] = cleaned
    return pruned

  if isinstance(value, list):
    if len(value) > MAX_STORE_LIST_LENGTH:
      return None
    out: List[Any] = []
    for item in value:
      cleaned = prune_store_payload(item)
      if cleaned is not None:
        out.append(cleaned)
    return out

  if isinstance(value, str):
    if len(value) > MAX_STORE_STRING_LENGTH:
      return None
    return value

  return value


def build_raw_record(appid: int, cc: str = "us") -> Optional[Dict[str, Any]]:
  store_all = fetch_store_meta(appid, cc)
  store_one = store_all.get(str(appid), {}) if isinstance(store_all, dict) else {}
  if not isinstance(store_one, dict) or not store_one.get("success"):
    return None

  store_pruned = prune_store_payload(store_one)
  spy_raw = fetch_spy_details(appid)
  return {
    str(appid): {
      "from_store": store_pruned,
      "from_spy": spy_raw,
    }
  }

def load_done_appids_from_jsonl(path: Path) -> set[int]:
  done: set[int] = set()
  if not path.exists():
    return done

  with path.open("r", encoding="utf-8") as f:
    for line_no, line in enumerate(f, 1):
      line = line.strip()
      if not line:
        continue
      try:
        obj = json.loads(line)
        if isinstance(obj, dict) and len(obj) == 1:
          k = next(iter(obj.keys()))
          done.add(int(k))
      except Exception:
        log_warn(f"Skip invalid jsonl line {line_no} in {path}")
  return done

def main() -> None:
  parser = argparse.ArgumentParser()
  parser.add_argument("--appid-list", type=str, default="data/processed/toplist_appids.json", help="Local appid list json path")
  parser.add_argument("--top-n", type=int, default=0, help="Optional truncate appid list (0 means all)")
  parser.add_argument("--store-cc", type=str, default="us", help="Store country code")
  parser.add_argument("--store-interval", type=float, default=STORE_INTERVAL, help="Store API min interval seconds")
  parser.add_argument("--spy-interval", type=float, default=STEAMSPY_INTERVAL, help="SteamSpy normal request min interval seconds")
  parser.add_argument("--spy-all-interval", type=float, default=STEAMSPY_ALL_INTERVAL, help="SteamSpy request=all min interval seconds")
  parser.add_argument("--max-retries", type=int, default=MAX_RETRIES, help="Max retries per request")
  parser.add_argument("--timeout", type=int, default=25, help="HTTP timeout in seconds")
  parser.add_argument("--out", type=str, default="scripts/games_raw.jsonl", help="Output jsonl file")
  parser.add_argument("--resume", action="store_true", help="Resume from existing --out jsonl (skip done appids)")

  args = parser.parse_args()

  if args.store_interval <= 0 or args.spy_interval <= 0 or args.spy_all_interval <= 0:
    raise ValueError("Intervals must be > 0")
  if args.max_retries <= 0:
    raise ValueError("max-retries must be > 0")
  if args.timeout <= 0:
    raise ValueError("timeout must be > 0")
  if args.top_n < 0:
    raise ValueError("top-n must be >= 0")

  global RETRY_LIMIT
  RETRY_LIMIT = args.max_retries

  store_limiter.min_interval = args.store_interval
  steamspy_limiter.min_interval = args.spy_interval
  steamspy_all_limiter.min_interval = args.spy_all_interval

  log_info("Starting fetch_games")
  log_info(
    f"Config: appid_list={args.appid_list}, top_n={args.top_n}, store_cc={args.store_cc}, "
    f"store_interval={args.store_interval}, spy_interval={args.spy_interval}, "
    f"spy_all_interval={args.spy_all_interval}, retries={args.max_retries}, timeout={args.timeout}s"
  )

  appids = load_local_appids(Path(args.appid_list), args.top_n)
  log_info(f"Loaded local appid count: {len(appids)}")
  out_path = Path(args.out)
  out_path.parent.mkdir(parents=True, exist_ok=True)

  done_appids: set[int] = set()
  if args.resume:
    done_appids = load_done_appids_from_jsonl(out_path)
    if done_appids:
      before = len(appids)
      appids = [x for x in appids if x not in done_appids]
      log_info(f"Resume enabled: done={len(done_appids)}, pending={len(appids)}, removed={before-len(appids)}")

  write_mode = "a" if (args.resume) else "w"
  log_info(f"Output mode: {write_mode} -> {out_path}")

  ok_count = 0
  skip_count = 0
  err_count = 0
  with out_path.open(write_mode, encoding="utf-8") as f:
    for appid in track(appids, description="Fetching games"):
      try:
        log_info(f"Building record for appid={appid}")
        record = build_raw_record(appid, args.store_cc)
        if record is None:
          skip_count += 1
          log_warn(f"[SKIP] {appid} no store data")
          continue
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
        ok_count += 1
        log_info(f"[OK] {appid}")
      except Exception as e:
        err_count += 1
        log_error(f"[ERR] {appid}: {e}")

  log_info(f"Saved {ok_count} lines -> {out_path}")
  log_info(f"Summary: ok={ok_count}, skip={skip_count}, err={err_count}")


if __name__ == "__main__":
  main()