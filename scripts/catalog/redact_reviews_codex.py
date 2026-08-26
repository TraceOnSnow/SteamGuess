#!/usr/bin/env python3
"""Batch and redact catalog reviews with Codex CLI and a low-cost model.

The command is designed for large unattended runs. Reviews are grouped by one
AppID and language, split by ``--batch-size``/``--max-chars``, and every
successful review is appended to a durable JSONL checkpoint. Re-running with
``--resume`` skips completed review identities.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from scripts.catalog.redact_reviews_ai import (
    CheckpointStore,
    PROMPT_VERSION,
    ReviewTask,
    collect_tasks,
    load_appids,
    load_json,
    load_prompt,
    make_record,
)

DEFAULT_OUT = "data/analysis/review-redaction/review_redactions.jsonl"
DEFAULT_MODEL = "gpt-5.6-luna"


@dataclass(frozen=True)
class Batch:
    tasks: tuple[ReviewTask, ...]


def make_batches(tasks: list[ReviewTask], batch_size: int, max_chars: int) -> list[Batch]:
    batches: list[Batch] = []
    current: list[ReviewTask] = []
    current_chars = 0
    current_group: tuple[int, str] | None = None
    for task in tasks:
        group = (task.app_id, task.language)
        task_chars = len(task.text)
        if current and (group != current_group or len(current) >= batch_size or current_chars + task_chars > max_chars):
            batches.append(Batch(tuple(current)))
            current = []
            current_chars = 0
        current.append(task)
        current_chars += task_chars
        current_group = group
    if current:
        batches.append(Batch(tuple(current)))
    return batches


def schema_payload() -> dict[str, Any]:
    entity = {
        "type": "object",
        "additionalProperties": False,
        "required": ["entity", "text", "replacement", "type"],
        "properties": {key: {"type": "string"} for key in ("entity", "text", "replacement", "type")},
    }
    item = {
        "type": "object",
        "additionalProperties": False,
        "required": ["taskId", "redactedText", "entities"],
        "properties": {
            "taskId": {"type": "string"},
            "redactedText": {"type": "string"},
            "entities": {"type": "array", "items": entity},
        },
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["results"],
        "properties": {"results": {"type": "array", "items": item}},
    }


def batch_prompt(batch: Batch) -> str:
    first = batch.tasks[0]
    payload = {
        "appId": first.app_id,
        "language": first.language,
        "gameTitles": list(first.titles),
        "reviews": [{"taskId": task.task_id, "reviewText": task.text} for task in batch.tasks],
    }
    return (
        load_prompt()
        + "\n\n## 批量输入补充规则\n"
        + "本次输入包含 reviews 数组。必须逐条处理并返回同样数量的结果，taskId 必须原样返回。"
        + "输出必须是 {\"results\":[{\"taskId\":...,\"redactedText\":...,\"entities\":[...]}]}。\n\n"
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    )


def parse_batch_result(path: Path, batch: Batch) -> dict[str, tuple[str, list[dict[str, str]]]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = payload.get("results") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise ValueError("model output does not contain results array")
    expected = {task.task_id for task in batch.tasks}
    results: dict[str, tuple[str, list[dict[str, str]]]] = {}
    for row in rows:
        if not isinstance(row, dict) or row.get("taskId") not in expected:
            raise ValueError("model output contains an unknown taskId")
        task_id = str(row["taskId"])
        text = row.get("redactedText")
        entities = row.get("entities")
        if not isinstance(text, str) or not isinstance(entities, list):
            raise ValueError(f"invalid result for {task_id}")
        results[task_id] = (text, entities)
    if set(results) != expected:
        raise ValueError(f"model returned {len(results)}/{len(expected)} reviews")
    return results


def invoke_codex(batch: Batch, model: str, timeout: float) -> dict[str, tuple[str, list[dict[str, str]]]]:
    with tempfile.TemporaryDirectory(prefix="steamguess-redaction-") as directory:
        root = Path(directory)
        schema = root / "schema.json"
        output = root / "output.json"
        schema.write_text(json.dumps(schema_payload(), ensure_ascii=False), encoding="utf-8")
        command = [
            os.environ.get("CODEX", "codex"), "exec", "-m", model,
            "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check",
            "-C", "/tmp", "--output-schema", str(schema), "--output-last-message", str(output), "-",
        ]
        subprocess.run(
            command,
            input=batch_prompt(batch),
            text=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            check=True,
            timeout=timeout,
        )
        return parse_batch_result(output, batch)


def run(args: argparse.Namespace) -> int:
    if args.batch_size < 1 or args.max_chars < 1000 or args.retries < 0 or args.delay < 0 or args.timeout <= 0:
        raise ValueError("invalid batch/retry/delay/timeout arguments")
    catalog = load_json(Path(args.catalog))
    appids = load_appids(Path(args.appids)) if args.appids else None
    all_tasks = collect_tasks(catalog, appids, args.language, 0)
    store = CheckpointStore(Path(args.out), True if args.resume else False)
    pending = [task for task in all_tasks if not (store.get(task.task_id) or {}).get("status") == "ok"]
    batches = make_batches(pending, args.batch_size, args.max_chars)
    if args.limit_batches:
        batches = batches[: args.limit_batches]
    completed = failures = 0
    for index, batch in enumerate(batches, 1):
        first = batch.tasks[0]
        for task in batch.tasks:
            if store.get(task.task_id) is None:
                store.put(make_record(task, status="pending", model=args.model))
        last_error: Exception | None = None
        for attempt in range(args.retries + 1):
            try:
                results = invoke_codex(batch, args.model, args.timeout)
                for task in batch.tasks:
                    text, entities = results[task.task_id]
                    store.put(make_record(task, status="ok", model=args.model, redacted_text=text, entities=entities))
                completed += len(batch.tasks)
                last_error = None
                break
            except (subprocess.SubprocessError, OSError, ValueError, json.JSONDecodeError) as error:
                last_error = error
                if attempt < args.retries:
                    wait = args.retry_delay * (2 ** attempt)
                    print(f"batch={index}/{len(batches)} retry={attempt + 1}/{args.retries} wait={wait:g}s error={error}", flush=True)
                    time.sleep(wait)
        if last_error is not None:
            failures += len(batch.tasks)
            for task in batch.tasks:
                store.put(make_record(task, status="failed", model=args.model, error=str(last_error)))
            print(f"batch={index}/{len(batches)} appid={first.app_id} language={first.language} failed={last_error}", flush=True)
        else:
            print(f"batch={index}/{len(batches)} appid={first.app_id} language={first.language} reviews={len(batch.tasks)} complete={completed}", flush=True)
        if index < len(batches):
            time.sleep(args.delay)
    store.compact()
    print(json.dumps({
        "tasks": len(all_tasks), "pendingAtStart": len(pending), "batches": len(batches),
        "completed": completed, "failures": failures, "out": args.out,
        "model": args.model, "promptVersion": PROMPT_VERSION,
    }, ensure_ascii=False))
    return 0 if failures == 0 or args.allow_failures else 2


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--catalog", default="data/catalog/steamspy_candidates.json")
    result.add_argument("--appids")
    result.add_argument("--out", default=DEFAULT_OUT)
    result.add_argument("--language", choices=("all", "english", "schinese"), default="all")
    result.add_argument("--model", default=DEFAULT_MODEL)
    result.add_argument("--batch-size", type=int, default=100)
    result.add_argument("--max-chars", type=int, default=80000)
    result.add_argument("--limit-batches", type=int, default=0)
    result.add_argument("--delay", type=float, default=1.0)
    result.add_argument("--timeout", type=float, default=600.0)
    result.add_argument("--retries", type=int, default=2)
    result.add_argument("--retry-delay", type=float, default=10.0)
    result.add_argument("--resume", action="store_true")
    result.add_argument("--allow-failures", action="store_true")
    return result


def main() -> None:
    args = parser().parse_args()
    try:
        raise SystemExit(run(args))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"error: {error}") from error


if __name__ == "__main__":
    main()
