# -*- coding: utf-8 -*-
"""Shared helpers for raw fetch scripts."""

from __future__ import annotations

import json
import random
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from json import JSONDecodeError
from pathlib import Path
from typing import Any, List
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from rich import print as rprint


USER_AGENT = "SteamGuessDataBot/0.2 (+https://example.local)"


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


def http_get_json(url: str, limiter: RateLimiter, retries: int, timeout: int, source_name: str) -> Any:
  backoff = 1.0
  for attempt in range(retries):
    waited = limiter.wait()
    if waited > 0:
      log_info(f"Rate limited by {source_name}, slept {waited:.2f}s")

    log_info(f"HTTP GET attempt {attempt + 1}/{retries} -> {url}")
    req = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})

    try:
      with urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8", errors="replace")
        try:
          payload = json.loads(body)
          log_info(f"HTTP OK ({source_name}), payload size={len(body)}")
          return payload
        except JSONDecodeError:
          sleep_for = backoff + random.random() * 0.5
          if "Too many connections" in body:
            sleep_for = max(sleep_for, 60.0 + random.random() * 2.0)
          log_warn(f"Non-JSON response ({source_name}) attempt {attempt + 1}/{retries}")
          log_warn(f"Body head: {body[:120]!r}")
          log_warn(f"Backoff sleep {sleep_for:.2f}s")
          time.sleep(sleep_for)
          backoff *= 2
          continue
    except HTTPError as err:
      if err.code in (429, 500, 502, 503, 504):
        sleep_for = backoff + random.random() * 0.5
        log_warn(f"HTTP {err.code} ({source_name}) attempt {attempt + 1}/{retries}, sleep {sleep_for:.2f}s")
        time.sleep(sleep_for)
        backoff *= 2
        continue
      log_error(f"HTTPError {err.code} ({source_name}) -> {url}")
      raise
    except URLError:
      sleep_for = backoff + random.random() * 0.5
      log_warn(f"URLError ({source_name}) attempt {attempt + 1}/{retries}, sleep {sleep_for:.2f}s")
      time.sleep(sleep_for)
      backoff *= 2

  raise RuntimeError(f"Failed after retries ({retries}): {url}")


def load_local_appids(path: Path) -> List[int]:
  if not path.exists():
    raise FileNotFoundError(f"appid list file not found: {path}")

  data = json.loads(path.read_text(encoding="utf-8"))
  if isinstance(data, dict) and isinstance(data.get("appids"), list):
    source = data["appids"]
  elif isinstance(data, list):
    source = data
  else:
    raise ValueError("appid list file must be {'appids': [...]} or a plain list")

  appids: List[int] = []
  for item in source:
    try:
      appids.append(int(item))
    except Exception:
      continue
  return appids


def apply_index_range(appids: List[int], start_index: int, end_index: int, top_n: int) -> List[int]:
  if start_index < 0:
    raise ValueError("start-index must be >= 0")
  if end_index != -1 and end_index < start_index:
    raise ValueError("end-index must be -1 or >= start-index")
  if top_n < 0:
    raise ValueError("top-n must be >= 0")

  sliced = appids[start_index:] if end_index == -1 else appids[start_index:end_index]
  if top_n > 0:
    sliced = sliced[:top_n]
  return sliced


def load_done_appids_from_jsonl(path: Path) -> set[int]:
  done: set[int] = set()
  if not path.exists():
    return done

  with path.open("r", encoding="utf-8") as handle:
    for line_no, line in enumerate(handle, 1):
      raw = line.strip()
      if not raw:
        continue
      try:
        obj = json.loads(raw)
        if isinstance(obj, dict) and len(obj) == 1:
          key = next(iter(obj.keys()))
          done.add(int(key))
      except Exception:
        log_warn(f"Skip invalid jsonl line {line_no} in {path}")
  return done


def now_timestamp() -> str:
  return datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")


def normalize_date(date_text: Any) -> str:
  if date_text is None:
    return ""

  if isinstance(date_text, (int, float)):
    if date_text <= 0:
      return ""
    return datetime.fromtimestamp(int(date_text), tz=timezone.utc).strftime("%Y-%m-%d")

  raw = str(date_text).strip()
  if not raw:
    return ""

  lowered = raw.lower()
  if lowered in {"coming soon", "to be announced", "tba", "soon"}:
    return ""

  candidates = [
    "%Y-%m-%d",
    "%d %b, %Y",
    "%b %d, %Y",
    "%d %B, %Y",
    "%B %d, %Y",
    "%Y/%m/%d",
    "%m/%d/%Y",
  ]
  for fmt in candidates:
    try:
      return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
    except ValueError:
      continue

  return raw
