# -*- coding: utf-8 -*-
"""Intersect appids from multiple JSON files."""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path
from typing import Any


DEFAULT_OUTPUT_DIR = "data/processed"


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser()
  parser.add_argument(
    "--inputs",
    nargs="+",
    required=True,
    help="Input JSON files (each contains only appids, either {'appids': [...]} or [...])",
  )
  parser.add_argument(
    "--out",
    type=str,
    default="",
    help="Optional output path; default data/processed/appids_intersection_<timestamp>.json",
  )
  return parser.parse_args()


def load_appids(path: Path) -> list[str]:
  if not path.exists():
    raise FileNotFoundError(f"Input file not found: {path}")

  data: Any = json.loads(path.read_text(encoding="utf-8"))
  if isinstance(data, dict) and isinstance(data.get("appids"), list):
    source = data["appids"]
  elif isinstance(data, list):
    source = data
  else:
    raise ValueError(f"Invalid appids JSON format: {path}")

  out: list[str] = []
  seen: set[str] = set()
  for item in source:
    try:
      appid = str(int(item))
    except Exception:
      continue
    if appid in seen:
      continue
    seen.add(appid)
    out.append(appid)
  return out


def main() -> None:
  args = parse_args()

  input_paths = [Path(p) for p in args.inputs]
  if len(input_paths) < 2:
    raise ValueError("Please provide at least 2 input files")

  loaded_lists = [load_appids(path) for path in input_paths]

  first_list = loaded_lists[0]
  intersection_set = set(first_list)
  for appid_list in loaded_lists[1:]:
    intersection_set &= set(appid_list)

  intersection_ordered = [appid for appid in first_list if appid in intersection_set]

  ts = datetime.now().strftime("%Y%m%d_%H%M%S")
  default_out = Path(DEFAULT_OUTPUT_DIR) / f"appids_intersection_{ts}.json"
  out_path = Path(args.out) if args.out else default_out
  out_path.parent.mkdir(parents=True, exist_ok=True)

  result = {"appids": intersection_ordered}
  out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

  print(f"[OK] inputs: {len(input_paths)}")
  for path, appids in zip(input_paths, loaded_lists):
    print(f"  - {path}: {len(appids)} appids")
  print(f"[OK] intersection: {len(intersection_ordered)} appids")
  print(f"[OK] output: {out_path}")


if __name__ == "__main__":
  main()
