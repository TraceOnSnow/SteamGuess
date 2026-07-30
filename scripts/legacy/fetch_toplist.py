# -*- coding: utf-8 -*-
"""
Fetch or load SteamSpy toplist, then normalize to appid list JSON.

Modes:
- api: fetch raw toplist from SteamSpy API
- file: load raw toplist from local JSON file

Output normalized format:
{
  "appids": [10, 20, 30]
}
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any, Dict, List
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from rich import print as rprint

USER_AGENT = "SteamGuessDataBot/0.1 (+https://example.local)"


def log_info(message: str) -> None:
  rprint(f"[cyan][INFO][/cyan] {message}")


def log_warn(message: str) -> None:
  rprint(f"[yellow][WARN][/yellow] {message}")


def fetch_steamspy_toplist(request_name: str, timeout: int) -> Dict[str, Any]:
  params = urlencode({"request": request_name})
  url = f"https://steamspy.com/api.php?{params}"
  req = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
  log_info(f"GET {url}")

  with urlopen(req, timeout=timeout) as resp:
    body = resp.read().decode("utf-8", errors="replace")
    return json.loads(body)


def load_toplist_from_file(path: Path) -> Dict[str, Any]:
  log_info(f"Reading local toplist file: {path}")
  return json.loads(path.read_text(encoding="utf-8"))


def normalize_appids(raw: Dict[str, Any]) -> List[int]:
  appids: List[int] = []
  seen = set()

  if not isinstance(raw, dict):
    return appids

  for key, value in raw.items():
    candidate = None

    if isinstance(value, dict) and "appid" in value:
      try:
        candidate = int(value["appid"])
      except Exception:
        candidate = None

    if candidate is None:
      try:
        candidate = int(key)
      except Exception:
        candidate = None

    if candidate is None:
      continue

    if candidate not in seen:
      seen.add(candidate)
      appids.append(candidate)

  return appids


def main() -> None:
  parser = argparse.ArgumentParser()
  parser.add_argument("--mode", choices=["api", "file"], default="file", help="Read source from SteamSpy API or local file")
  parser.add_argument("--request", type=str, default="top100in2weeks", help="SteamSpy request when mode=api")
  parser.add_argument("--source-file", type=str, default="data/raw/toplists/top1000_20260224.json", help="Local raw toplist path when mode=file")
  parser.add_argument("--raw-out", type=str, default="", help="Optional path to save raw API response when mode=api")
  parser.add_argument("--out", type=str, default="data/processed/toplist_appids.json", help="Output normalized appid list JSON")
  parser.add_argument("--top-n", type=int, default=0, help="Optional truncate appid list (0 means keep all)")
  parser.add_argument("--timeout", type=int, default=25, help="HTTP timeout in seconds")
  args = parser.parse_args()

  if args.timeout <= 0:
    raise ValueError("timeout must be > 0")
  if args.top_n < 0:
    raise ValueError("top-n must be >= 0")

  if args.mode == "api":
    raw = fetch_steamspy_toplist(args.request, args.timeout)
    if args.raw_out:
      raw_path = Path(args.raw_out)
      raw_path.parent.mkdir(parents=True, exist_ok=True)
      raw_path.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
      log_info(f"Saved raw toplist -> {raw_path}")
  else:
    source_path = Path(args.source_file)
    if not source_path.exists():
      raise FileNotFoundError(f"source file not found: {source_path}")
    raw = load_toplist_from_file(source_path)

  appids = normalize_appids(raw)
  if args.top_n > 0:
    appids = appids[:args.top_n]

  if not appids:
    log_warn("No appids extracted from toplist source")

  out_data = {"appids": appids}
  out_path = Path(args.out)
  out_path.parent.mkdir(parents=True, exist_ok=True)
  out_path.write_text(json.dumps(out_data, ensure_ascii=False, indent=2), encoding="utf-8")

  log_info(f"Saved normalized toplist -> {out_path}")
  log_info(f"Appid count: {len(appids)}")


if __name__ == "__main__":
  main()
