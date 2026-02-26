# -*- coding: utf-8 -*-
"""
Filter appids from SteamSpy toplist pages by CCU threshold.

Input directory contains files like:
  page0.json, page1.json, ...

Each file is expected to be a dict keyed by appid string, with values containing fields like:
  {"appid": 730, "ccu": 1013936, ...}

Output:
  data/processed/appids_spy_<timestamp>.json
  {
    "appids": ["730", "..."],
    "meta": { ... }
  }
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any


DEFAULT_INPUT_DIR = "data/raw/toplists/20260225_224527"
DEFAULT_OUTPUT_DIR = "data/processed"


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser()
  parser.add_argument(
    "--input-dir",
    type=str,
    default=DEFAULT_INPUT_DIR,
    help="Directory containing page{n}.json files",
  )
  parser.add_argument(
    "--min-ccu",
    type=int,
    default=0,
    help="Keep appids where ccu > min-ccu",
  )
  parser.add_argument(
    "--out",
    type=str,
    default="",
    help="Optional output path; default data/processed/appids_spy_<timestamp>.json",
  )
  return parser.parse_args()


def page_index(path: Path) -> int:
  match = re.search(r"page(\d+)\.json$", path.name)
  if not match:
    return 10**9
  return int(match.group(1))


def read_json_file(path: Path) -> dict[str, Any]:
  text = path.read_text(encoding="utf-8", errors="ignore")
  data = json.loads(text)
  if not isinstance(data, dict):
    raise ValueError(f"Expected object in {path}, got {type(data).__name__}")
  return data


def extract_appid(entry_key: str, entry_value: Any) -> str | None:
  if isinstance(entry_value, dict):
    appid_val = entry_value.get("appid")
    if appid_val is not None:
      try:
        return str(int(appid_val))
      except Exception:
        pass

  try:
    return str(int(entry_key))
  except Exception:
    return None


def extract_ccu(entry_value: Any) -> int | None:
  if not isinstance(entry_value, dict):
    return None

  raw = entry_value.get("ccu")
  if raw is None:
    return None

  try:
    return int(raw)
  except Exception:
    return None


def main() -> None:
  args = parse_args()

  if args.min_ccu < 0:
    raise ValueError("min-ccu must be >= 0")

  input_dir = Path(args.input_dir)
  if not input_dir.exists() or not input_dir.is_dir():
    raise FileNotFoundError(f"Input dir not found: {input_dir}")

  page_files = sorted(input_dir.glob("page*.json"), key=page_index)
  if not page_files:
    raise FileNotFoundError(f"No page*.json found in: {input_dir}")

  ts = datetime.now().strftime("%Y%m%d_%H%M%S")
  default_out = Path(DEFAULT_OUTPUT_DIR) / f"appids_spy_{ts}.json"
  out_path = Path(args.out) if args.out else default_out
  out_path.parent.mkdir(parents=True, exist_ok=True)

  appids: list[str] = []
  seen: set[str] = set()

  total_entries = 0
  filtered_entries = 0

  for page_file in page_files:
    payload = read_json_file(page_file)

    for key, value in payload.items():
      total_entries += 1
      ccu = extract_ccu(value)
      if ccu is None or ccu <= args.min_ccu:
        continue

      appid = extract_appid(key, value)
      if appid is None or appid in seen:
        continue

      seen.add(appid)
      appids.append(appid)
      filtered_entries += 1

  result = {
    "appids": appids,
    "meta": {
      "inputDir": str(input_dir),
      "pageFileCount": len(page_files),
      "minCcu": args.min_ccu,
      "totalEntriesScanned": total_entries,
      "appidsMatched": filtered_entries,
      "generatedAt": ts,
    },
  }

  out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

  print(f"[OK] scanned files: {len(page_files)}")
  print(f"[OK] total entries: {total_entries}")
  print(f"[OK] matched appids (ccu > {args.min_ccu}): {len(appids)}")
  print(f"[OK] output: {out_path}")


if __name__ == "__main__":
  main()
