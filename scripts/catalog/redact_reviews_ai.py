#!/usr/bin/env python3
"""Offline/resumable AI review redaction pipeline.

The script reads review text from a catalog JSON and writes an independent JSON
or JSONL cache. It never mutates the catalog, SQLite, or public frontend files.
Use JSONL for large runs: each result is fsync'd as an append-only checkpoint.

Model access is provided by LiteLLM and imported only when a real request is
made. Dry runs and tests therefore do not require LiteLLM to be installed.
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import importlib
import json
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError, URLError

PROMPT_VERSION = "review-redaction-v1"
DEFAULT_CATALOG = "data/catalog/steamspy_candidates.json"
DEFAULT_OUT = "data/analysis/review-redaction/review_redactions.jsonl"
PROMPT_PATH = Path(__file__).with_name("review_redaction_prompt.zh-CN.md")
RETRYABLE_HTTP_STATUS = {408, 425, 429, 500, 502, 503, 504}
LANGUAGE_CHOICES = ("all", "english", "schinese")
SCOPE_CHOICES = ("active", "detail", "all")


@dataclass(frozen=True)
class ReviewTask:
    task_id: str
    app_id: int
    language: str
    review_id: str
    text: str
    titles: tuple[str, ...]
    source_hash: str


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_games(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict) and isinstance(payload.get("games"), list):
        source = payload["games"]
    elif isinstance(payload, list):
        source = payload
    elif isinstance(payload, dict):
        # Also accept public-style {"appid": {...}} catalogs.
        source = sorted(
            (
                value
                for value in payload.values()
                if isinstance(value, dict) and value.get("appId") is not None
            ),
            key=lambda game: int(game.get("appId", 0)),
        )
    else:
        source = []
    return [game for game in source if isinstance(game, dict) and game.get("appId") is not None]


def load_appids(path: Path | None) -> set[int] | None:
    if path is None:
        return None
    payload = load_json(path)
    if isinstance(payload, dict) and "appIds" in payload:
        payload = payload["appIds"]
    if isinstance(payload, dict):
        payload = list(payload.keys())
    if not isinstance(payload, list):
        raise ValueError("--appids must point to a JSON array or an object containing appIds")
    try:
        return {int(value) for value in payload}
    except (TypeError, ValueError) as error:
        raise ValueError("--appids contains a non-numeric AppID") from error


def _titles_for_game(game: dict[str, Any]) -> tuple[str, ...]:
    values: list[str] = []
    for key in ("name", "localizedName", "chineseName"):
        value = game.get(key)
        if isinstance(value, str):
            values.append(value)
    localized = game.get("localizedNames")
    if isinstance(localized, dict):
        values.extend(value for value in localized.values() if isinstance(value, str))
    # Longest first helps the model and makes the request deterministic.
    unique = dict.fromkeys(value.strip() for value in values if value.strip())
    return tuple(sorted(unique, key=lambda value: (-len(value), value.casefold())))


def _review_items(game: dict[str, Any]) -> Iterable[tuple[str, dict[str, Any]]]:
    reviews = game.get("reviews")
    if isinstance(reviews, dict):
        language_order = {"english": 0, "schinese": 1}
        for language in sorted(reviews, key=lambda value: (language_order.get(str(value), 2), str(value))):
            items = reviews[language]
            if isinstance(items, list):
                for item in items:
                    if isinstance(item, dict):
                        yield str(language), item
    elif isinstance(reviews, list):
        for item in reviews:
            if isinstance(item, dict):
                language = str(item.get("language") or "english")
                yield language, item


def make_task(game: dict[str, Any], language: str, review: dict[str, Any]) -> ReviewTask | None:
    try:
        app_id = int(game["appId"])
    except (KeyError, TypeError, ValueError):
        return None
    text = str(review.get("text") or review.get("review") or "").strip()
    if not text:
        return None
    review_id = str(review.get("reviewId") or review.get("recommendationid") or "")
    source_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
    identity = review_id or source_hash[:24]
    task_id = f"{app_id}:{language}:{identity}"
    return ReviewTask(task_id, app_id, language, review_id, text, _titles_for_game(game), source_hash)


def collect_tasks(
    catalog: Any,
    appids: set[int] | None,
    language: str,
    limit: int = 0,
    *,
    scope: str = "all",
    active_limit: int = 1000,
    detail_limit: int = 4000,
    reviews_per_language: int = 0,
) -> list[ReviewTask]:
    """Select review tasks in stable SteamSpy/catalog order.

    Catalog arrays are already ranked by the weekly discovery pipeline, so
    scope is a deterministic prefix. Reviews retain Steam's helpful-review
    order. ``--appids`` is an additional filter rather than a replacement for
    scope, making repeated invocations reproducible.
    """
    games = load_games(catalog)
    if scope == "active":
        games = games[:active_limit]
    elif scope == "detail":
        games = games[:detail_limit]
    elif scope != "all":
        raise ValueError(f"unsupported scope: {scope}")

    tasks: list[ReviewTask] = []
    for game in games:
        app_id = int(game["appId"])
        if appids is not None and app_id not in appids:
            continue
        language_counts: dict[str, int] = {}
        for item_language, review in _review_items(game):
            if language != "all" and item_language != language:
                continue
            if reviews_per_language > 0 and language_counts.get(item_language, 0) >= reviews_per_language:
                continue
            task = make_task(game, item_language, review)
            if task is not None:
                tasks.append(task)
                language_counts[item_language] = language_counts.get(item_language, 0) + 1
                if limit > 0 and len(tasks) >= limit:
                    return tasks
    return tasks


def _record_key(record: dict[str, Any]) -> str:
    task_id = record.get("taskId")
    if isinstance(task_id, str) and task_id:
        return task_id
    return f"{record.get('appId')}:{record.get('language')}:{record.get('reviewId', '')}"


def _atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    with temporary.open("wb") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)


def _jsonl_bytes(records: Iterable[dict[str, Any]]) -> bytes:
    return b"".join((json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8") for record in records)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    raw = path.read_bytes()
    records: list[dict[str, Any]] = []
    valid_parts: list[bytes] = []
    malformed_tail = False
    lines = raw.splitlines(keepends=True)
    for index, line in enumerate(lines):
        if not line.strip():
            valid_parts.append(line)
            continue
        try:
            value = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            if index == len(lines) - 1:
                malformed_tail = True
                break
            raise ValueError(f"invalid JSONL record in {path}")
        if not isinstance(value, dict):
            raise ValueError(f"JSONL record must be an object in {path}")
        records.append(value)
        valid_parts.append(line)
    if malformed_tail:
        # A killed process can leave only a partial final line. Repair it by an
        # atomic replacement before resuming, without touching valid records.
        _atomic_write(path, b"".join(valid_parts))
    return records


class CheckpointStore:
    """Last-write-wins cache with durable per-record checkpoints."""

    def __init__(self, path: Path, resume: bool):
        self.path = path
        self.jsonl = path.suffix.lower() == ".jsonl"
        self.records: list[dict[str, Any]] = []
        self.by_key: dict[str, dict[str, Any]] = {}
        if resume and path.exists():
            self.records = read_jsonl(path) if self.jsonl else _load_json_records(path)
            for record in self.records:
                self.by_key[_record_key(record)] = record

    def get(self, task_id: str) -> dict[str, Any] | None:
        return self.by_key.get(task_id)

    def put(self, record: dict[str, Any]) -> None:
        key = _record_key(record)
        previous = self.by_key.get(key)
        self.by_key[key] = record
        if self.jsonl:
            # A single fsync'd append is the checkpoint. On resume the last
            # record for a task wins; a partial tail is repaired by read_jsonl.
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("ab") as handle:
                handle.write((json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
                handle.flush()
                os.fsync(handle.fileno())
            # Keep the in-memory first-seen order in sync so compact() does not
            # discard records created during the current process.
            if previous is None:
                self.records.append(record)
            else:
                self.records[self.records.index(previous)] = record
        else:
            if previous is None:
                self.records.append(record)
            else:
                self.records[self.records.index(previous)] = record
            _atomic_write(self.path, (json.dumps(self.records, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))

    def compact(self) -> None:
        if self.jsonl:
            # Keep first-seen order, with the final value for every task.
            seen: set[str] = set()
            compacted: list[dict[str, Any]] = []
            for record in self.records:
                key = _record_key(record)
                if key in seen:
                    continue
                seen.add(key)
                compacted.append(self.by_key[key])
            _atomic_write(self.path, _jsonl_bytes(compacted))
            self.records = compacted


def _load_json_records(path: Path) -> list[dict[str, Any]]:
    payload = load_json(path)
    if not isinstance(payload, list) or not all(isinstance(item, dict) for item in payload):
        raise ValueError("JSON cache must contain an array of objects")
    return payload


def load_prompt() -> str:
    return PROMPT_PATH.read_text(encoding="utf-8")


class ModelResponseError(RuntimeError):
    pass


def _extract_json(value: str) -> dict[str, Any]:
    text = value.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        text = "\n".join(line for line in lines if not line.strip().startswith("```")).strip()
    try:
        result = json.loads(text)
    except json.JSONDecodeError:
        decoder = json.JSONDecoder()
        for index, char in enumerate(text):
            if char == "{":
                try:
                    result, _ = decoder.raw_decode(text[index:])
                    break
                except json.JSONDecodeError:
                    continue
        else:
            raise ModelResponseError("model response is not valid JSON")
    if not isinstance(result, dict):
        raise ModelResponseError("model response JSON must be an object")
    return result


def normalize_model_result(payload: dict[str, Any]) -> tuple[str, list[dict[str, str]]]:
    redacted = payload.get("redactedText")
    entities = payload.get("entities", [])
    if not isinstance(redacted, str):
        raise ModelResponseError("model response missing string redactedText")
    if not isinstance(entities, list):
        raise ModelResponseError("model response entities must be an array")
    normalized: list[dict[str, str]] = []
    for entity in entities:
        if not isinstance(entity, dict):
            raise ModelResponseError("each entity must be an object")
        values = {key: entity.get(key) for key in ("entity", "text", "replacement", "type")}
        if not all(isinstance(value, str) and value.strip() for value in values.values()):
            raise ModelResponseError("each entity requires entity/text/replacement/type strings")
        normalized.append({key: value.strip() for key, value in values.items()})
    return redacted, normalized


def _response_content(response: Any) -> str:
    if hasattr(response, "model_dump"):
        response = response.model_dump()
    if isinstance(response, dict):
        try:
            content = response["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as error:
            raise ModelResponseError("model response missing choices[0].message.content") from error
    else:
        try:
            content = response.choices[0].message.content
        except (AttributeError, IndexError, TypeError) as error:
            raise ModelResponseError("model response missing choices[0].message.content") from error
    if isinstance(content, list):
        content = "".join(
            part.get("text", "") if isinstance(part, dict) else str(getattr(part, "text", ""))
            for part in content
        )
    if not isinstance(content, str):
        raise ModelResponseError("model response content must be a string")
    return content


class LiteLLMAdapter:
    """Small lazy adapter around LiteLLM's provider-agnostic completion API."""

    def __init__(
        self,
        *,
        model: str,
        api_base: str | None = None,
        api_key: str | None = None,
        timeout: float = 60.0,
    ):
        self.model = model
        self.api_base = api_base
        self.api_key = api_key
        self.timeout = timeout
        self._module: Any | None = None

    def _litellm(self) -> Any:
        if self._module is None:
            try:
                self._module = importlib.import_module("litellm")
            except ImportError as error:
                raise RuntimeError(
                    "LiteLLM is required for real model calls; install it with `python3 -m pip install litellm`"
                ) from error
        return self._module

    def redact(self, task: ReviewTask, prompt: str) -> tuple[str, list[dict[str, str]]]:
        user_payload = {
            "appId": task.app_id,
            "language": task.language,
            "reviewId": task.review_id,
            "gameTitles": list(task.titles),
            "reviewText": task.text,
        }
        kwargs: dict[str, Any] = {
            "model": self.model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": prompt},
                {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
            ],
            "response_format": {"type": "json_object"},
            "timeout": self.timeout,
            # The outer loop owns retries so every attempt is checkpointed and
            # has one predictable backoff policy across providers.
            "num_retries": 0,
        }
        if self.api_base:
            kwargs["api_base"] = self.api_base
        if self.api_key:
            kwargs["api_key"] = self.api_key
        response = self._litellm().completion(**kwargs)
        return normalize_model_result(_extract_json(_response_content(response)))


def redact_with_model(task: ReviewTask, prompt: str, adapter: LiteLLMAdapter) -> tuple[str, list[dict[str, str]]]:
    """Compatibility seam kept small so callers/tests can inject a fake."""
    try:
        return adapter.redact(task, prompt)
    except HTTPError as error:
        if error.code in RETRYABLE_HTTP_STATUS:
            raise
        raise ModelResponseError(f"HTTP {error.code}") from error


def make_record(task: ReviewTask, *, status: str, model: str, redacted_text: str = "", entities: list[dict[str, str]] | None = None, error: str | None = None) -> dict[str, Any]:
    record: dict[str, Any] = {
        "taskId": task.task_id,
        "appId": task.app_id,
        "language": task.language,
        "reviewId": task.review_id,
        "sourceHash": task.source_hash,
        "redactedText": redacted_text,
        "entities": entities or [],
        "status": status,
        "model": model,
        "promptVersion": PROMPT_VERSION,
        "updatedAt": utc_now(),
    }
    if error:
        record["error"] = error
    return record


def _retryable(error: Exception) -> bool:
    if isinstance(error, (HTTPError, URLError, TimeoutError, http.client.RemoteDisconnected, ConnectionResetError, OSError)):
        return True
    status = getattr(error, "status_code", None)
    if status in RETRYABLE_HTTP_STATUS:
        return True
    name = type(error).__name__.casefold()
    return any(token in name for token in ("timeout", "ratelimit", "serviceunavailable", "apiconnection"))


def _completed_for_input(record: dict[str, Any] | None, task: ReviewTask, model: str) -> bool:
    return bool(
        record
        and record.get("status") == "ok"
        and record.get("sourceHash") == task.source_hash
        and record.get("promptVersion") == PROMPT_VERSION
        and record.get("model") == model
    )


def run(args: argparse.Namespace) -> int:
    catalog = load_json(Path(args.catalog))
    selected_appids = load_appids(Path(args.appids)) if args.appids else None
    if (
        args.limit < 0
        or args.reviews_per_language < 0
        or args.active_limit < 1
        or args.detail_limit < args.active_limit
        or args.retries < 0
        or args.delay < 0
        or args.timeout <= 0
        or args.retry_delay < 0
    ):
        raise ValueError(
            "limits/retries/delay/retry-delay must be non-negative, active-limit must be positive, "
            "detail-limit must be >= active-limit, and timeout must be positive"
        )
    tasks = collect_tasks(
        catalog,
        selected_appids,
        args.language,
        args.limit,
        scope=args.scope,
        active_limit=args.active_limit,
        detail_limit=args.detail_limit,
        reviews_per_language=args.reviews_per_language,
    )
    if not args.resume and Path(args.out).exists():
        raise ValueError(f"output exists; pass --resume to continue: {args.out}")
    model = args.model or os.environ.get("STEAMGUESS_REDACTION_MODEL") or os.environ.get("DIFFICULTY_AI_MODEL")
    if not model and not args.dry_run:
        raise ValueError("missing model; pass --model or set STEAMGUESS_REDACTION_MODEL")
    model = model or "dry-run"
    api_base = args.api_base or os.environ.get("STEAMGUESS_REDACTION_API_BASE") or os.environ.get("DIFFICULTY_AI_BASE_URL")
    api_key = None
    if args.api_key_env:
        api_key = os.environ.get(args.api_key_env)
        if not api_key and not args.dry_run:
            raise ValueError(f"environment variable {args.api_key_env} is not set")
    else:
        api_key = os.environ.get("STEAMGUESS_REDACTION_API_KEY") or os.environ.get("DIFFICULTY_AI_API_KEY")
    adapter = None if args.dry_run else LiteLLMAdapter(
        model=model,
        api_base=api_base,
        api_key=api_key,
        timeout=args.timeout,
    )
    prompt = load_prompt()
    store = CheckpointStore(Path(args.out), args.resume)
    failures = 0
    processed = 0
    skipped = 0
    for task in tasks:
        existing = store.get(task.task_id)
        if _completed_for_input(existing, task, model):
            skipped += 1
            continue
        if existing is None:
            store.put(make_record(task, status="pending", model=model))
        elif existing.get("status") != "pending":
            store.put(make_record(task, status="pending", model=model))
        if args.dry_run:
            processed += 1
            continue
        if processed > 0:
            time.sleep(args.delay)
        last_error: Exception | None = None
        for attempt in range(args.retries + 1):
            try:
                assert adapter is not None
                redacted, entities = redact_with_model(task, prompt, adapter)
                store.put(make_record(task, status="ok", model=model, redacted_text=redacted, entities=entities))
                last_error = None
                break
            except Exception as error:  # one review must never stop the batch
                last_error = error
                if attempt < args.retries and _retryable(error):
                    wait = args.retry_delay * (2 ** attempt)
                    print(f"{task.app_id}/{task.language}/{task.review_id}: retry {attempt + 1}/{args.retries} in {wait:g}s ({error})", flush=True)
                    time.sleep(wait)
                elif attempt < args.retries and isinstance(error, ModelResponseError):
                    # Malformed model output is also safe to retry.
                    wait = args.retry_delay * (2 ** attempt)
                    time.sleep(wait)
                else:
                    break
        processed += 1
        if last_error is not None:
            failures += 1
            store.put(make_record(task, status="failed", model=model, error=str(last_error)))
            print(f"{task.app_id}/{task.language}/{task.review_id}: failed: {last_error}", file=sys.stderr, flush=True)
    if not args.dry_run:
        store.compact()
    print(json.dumps({"tasks": len(tasks), "processed": processed, "skipped": skipped, "failures": failures, "dryRun": args.dry_run, "out": str(args.out)}, ensure_ascii=False))
    return 0 if failures == 0 or args.allow_failures else 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", default=DEFAULT_CATALOG, help="Input catalog JSON; it is never modified")
    parser.add_argument("--appids", help="Optional JSON AppID list, applied in addition to --scope")
    parser.add_argument("--out", default=DEFAULT_OUT, help="Independent .json or .jsonl cache")
    parser.add_argument("--dry-run", action="store_true", help="Create pending task records without network/model calls")
    parser.add_argument("--resume", action="store_true", help="Resume from an existing output cache")
    parser.add_argument("--limit", type=int, default=0, help="Maximum number of review tasks; 0 means all")
    parser.add_argument("--scope", choices=SCOPE_CHOICES, default="detail", help="Ranked catalog window to process")
    parser.add_argument("--active-limit", type=int, default=1000, help="Number of ranked games in active scope")
    parser.add_argument("--detail-limit", type=int, default=4000, help="Number of ranked games in detail scope")
    parser.add_argument(
        "--reviews-per-language",
        type=int,
        default=100,
        help="Maximum deterministic candidates per game/language; 0 means all",
    )
    parser.add_argument("--language", choices=LANGUAGE_CHOICES, default="all")
    parser.add_argument("--model", default="", help="LiteLLM model name, e.g. openai/gpt-4o-mini or ollama/qwen2.5")
    parser.add_argument("--api-base", default="", help="Optional provider/OpenAI-compatible base URL")
    parser.add_argument("--api-key-env", default="", help="Optional environment variable containing the provider API key")
    parser.add_argument("--delay", type=float, default=2.0, help="Delay between model calls in seconds")
    parser.add_argument("--timeout", type=float, default=60.0, help="HTTP timeout in seconds")
    parser.add_argument("--retries", type=int, default=3, help="Retries for transient/model response failures")
    parser.add_argument("--retry-delay", type=float, default=5.0, help="Initial exponential retry delay")
    parser.add_argument("--allow-failures", action="store_true", help="Exit zero after recording failed items")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    try:
        raise SystemExit(run(args))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"error: {error}") from error


if __name__ == "__main__":
    main()
