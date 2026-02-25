# -*- coding: utf-8 -*-
"""
Convert raw JSONL records to SteamGuess public games.json
Input line format:
{"12334": {"from_store": {...}, "from_spy": {...}}}

Output format:
{
  "12334": {
    "appId": 12334,
    ...
  }
}
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional


def parse_release_date(raw: str) -> str:
  raw = (raw or "").strip()
  if not raw:
    return "1970-01-01"
  for fmt in ("%d %b, %Y", "%b %d, %Y", "%Y-%m-%d"):
    try:
      return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
    except ValueError:
      pass
  return "1970-01-01"


def to_int(value: Any, default: int = 0) -> int:
  try:
    return int(value)
  except Exception:
    return default


def parse_owners_upper(owners: str) -> int:
  if not owners:
    return 0
  parts = owners.split("..")
  if len(parts) != 2:
    return 0
  hi = parts[1].strip().replace(",", "")
  return int(hi) if hi.isdigit() else 0


def extract_store_payload(from_store: Dict[str, Any]) -> Dict[str, Any]:
  if not isinstance(from_store, dict):
    return {}
  data = from_store.get("data")
  if isinstance(data, dict):
    return data
  return {}


def extract_spy_tags(spy: Dict[str, Any]) -> List[str]:
  tags = spy.get("tags")
  if isinstance(tags, dict):
    return list(tags.keys())
  return []


def build_game(appid: int, from_store: Dict[str, Any], from_spy: Dict[str, Any]) -> Optional[Dict[str, Any]]:
  store_data = extract_store_payload(from_store)
  if not store_data:
    return None

  name = str(store_data.get("name") or from_spy.get("name") or f"App {appid}")
  release_date = parse_release_date((store_data.get("release_date") or {}).get("date", ""))

  price_overview = store_data.get("price_overview") or {}
  us_currency = ""
  us_current = 0.0
  if isinstance(price_overview, dict):
    us_currency = str(price_overview.get("currency") or "")
    us_current = round((to_int(price_overview.get("final"), 0) or 0) / 100, 2)
  if bool(store_data.get("is_free")):
    us_current = 0.0

  ccu = to_int(from_spy.get("ccu"), 0)
  owners_upper = parse_owners_upper(str(from_spy.get("owners", "")))

  positive = to_int(from_spy.get("positive"), 0)
  negative = to_int(from_spy.get("negative"), 0)
  review_count = max(0, positive + negative)

  developers = store_data.get("developers") or []
  publishers = store_data.get("publishers") or []

  if not isinstance(developers, list):
    developers = []
  if not isinstance(publishers, list):
    publishers = []

  screenshots = store_data.get("screenshots") or []
  screenshot_url = ""
  if isinstance(screenshots, list) and screenshots:
    first = screenshots[0]
    if isinstance(first, dict):
      screenshot_url = str(first.get("path_full") or first.get("path_thumbnail") or "")

  header_image = store_data.get("header_image") or ""

  game = {
    "appId": appid,
    "name": name,
    "releaseDate": release_date,
    "price": {
      "us": {
        "currency": us_currency,
        "current": us_current,
      },
      "cn": {},
    },
    "popularity": {
      "ccu": ccu,
      "owners": owners_upper,
    },
    "reviews": {
      "total": review_count,
      "positive": positive,
      "negative": negative,
    },
    "tags": {
      "userTags": extract_spy_tags(from_spy),
      "developers": developers,
      "publishers": publishers,
    },
    "hints": {
      "screenshotUrl": screenshot_url,
      "funnyReview": "",
    },
    "header_image": header_image
  }

  return game


def convert(input_path: Path, output_path: Path) -> int:
  games: Dict[str, Dict[str, Any]] = {}

  with input_path.open("r", encoding="utf-8") as f:
    for line_no, line in enumerate(f, start=1):
      line = line.strip()
      if not line:
        continue

      try:
        row = json.loads(line)
      except json.JSONDecodeError:
        print(f"[SKIP] line {line_no} invalid JSON")
        continue

      if not isinstance(row, dict) or len(row) != 1:
        print(f"[SKIP] line {line_no} wrong row shape")
        continue

      appid_raw = next(iter(row.keys()))
      payload = row.get(appid_raw)
      if not isinstance(payload, dict):
        print(f"[SKIP] line {line_no} payload not object")
        continue

      try:
        appid = int(appid_raw)
      except ValueError:
        print(f"[SKIP] line {line_no} appid invalid: {appid_raw}")
        continue

      from_store = payload.get("from_store", {})
      from_spy = payload.get("from_spy", {})
      if not isinstance(from_store, dict):
        from_store = {}
      if not isinstance(from_spy, dict):
        from_spy = {}

      game = build_game(appid, from_store, from_spy)
      if game:
        games[str(appid)] = game

  output_path.parent.mkdir(parents=True, exist_ok=True)
  output_path.write_text(json.dumps(games, ensure_ascii=False, indent=2), encoding="utf-8")
  return len(games)


def main() -> None:
  parser = argparse.ArgumentParser()
  parser.add_argument("--in", dest="input", type=str, default="scripts/games_raw.jsonl", help="Input raw jsonl")
  parser.add_argument("--out", dest="output", type=str, default="public/games.json", help="Output static games json")
  args = parser.parse_args()

  count = convert(Path(args.input), Path(args.output))
  print(f"Saved {count} games -> {args.output}")


if __name__ == "__main__":
  main()
