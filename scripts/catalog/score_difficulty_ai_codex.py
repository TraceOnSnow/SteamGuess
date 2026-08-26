#!/usr/bin/env python3
"""Score SteamGuess game difficulty in resumable batches through Codex CLI."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Callable


DEFAULT_INPUT = Path("data/analysis/difficulty-ai-v2/input.json")
DEFAULT_PROMPT = Path("data/analysis/difficulty-ai-v2/PROMPT.zh-CN.md")
DEFAULT_OUT = Path("data/analysis/difficulty-ai-v3/deepseek-v4-flash-candidates.json")
DEFAULT_CHECKPOINT_DIR = Path("data/analysis/difficulty-ai-v3/checkpoints")
DEFAULT_MODEL = "deepseek-v4-flash"
VALID_EXCLUSION_REASONS = {
    "software",
    "tool",
    "benchmark",
    "server",
    "demo",
    "soundtrack",
    "dlc",
    "duplicate",
    "test-content",
    "not-a-reasonable-guess",
}
VALID_PRIORITIES = {"high", "normal", "low"}


def level_for_score(score: int) -> str:
    if score < 15:
        return "beginner"
    if score < 25:
        return "easy"
    if score < 50:
        return "normal"
    if score < 75:
        return "hard"
    return "hell"


def atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def load_input(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    games = payload.get("games")
    if not isinstance(games, list) or not games:
        raise ValueError("input does not contain a non-empty games array")
    appids = [game.get("appId") for game in games if isinstance(game, dict)]
    if len(appids) != len(games) or any(type(appid) is not int for appid in appids):
        raise ValueError("every input game must contain an integer appId")
    if len(set(appids)) != len(appids):
        raise ValueError("input contains duplicate AppIDs")
    return payload


def mixed_games(games: list[dict[str, Any]], seed: str) -> list[dict[str, Any]]:
    """Mix the popularity-sorted export without introducing nondeterminism."""
    return sorted(
        games,
        key=lambda game: hashlib.sha256(
            f"{seed}:{game['appId']}".encode("utf-8")
        ).digest(),
    )


def make_batches(
    games: list[dict[str, Any]],
    batch_size: int,
    seed: str,
) -> list[list[dict[str, Any]]]:
    if batch_size < 1:
        raise ValueError("batch size must be positive")
    ordered = mixed_games(games, seed)
    return [
        ordered[offset : offset + batch_size]
        for offset in range(0, len(ordered), batch_size)
    ]


def output_schema(expected_count: int) -> dict[str, Any]:
    evaluation = {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "appId",
            "eligible",
            "exclusionReason",
            "score",
            "level",
            "beginner",
            "confidence",
            "reason",
            "reviewPriority",
        ],
        "properties": {
            "appId": {"type": "integer"},
            "eligible": {"type": "boolean"},
            "exclusionReason": {
                "type": ["string", "null"],
                "enum": [None, *sorted(VALID_EXCLUSION_REASONS)],
            },
            "score": {"type": "integer", "minimum": 0, "maximum": 100},
            "level": {"type": "string", "enum": ["beginner", "easy", "normal", "hard", "hell"]},
            "beginner": {"type": "boolean"},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "reason": {"type": "string", "minLength": 1, "maxLength": 60},
            "reviewPriority": {
                "type": "string",
                "enum": sorted(VALID_PRIORITIES),
            },
        },
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["schemaVersion", "model", "rubricVersion", "evaluations"],
        "properties": {
            "schemaVersion": {"type": "integer", "const": 2},
            "model": {"type": "string"},
            "rubricVersion": {
                "type": "string",
                "const": "steamguess-difficulty-v3",
            },
            "evaluations": {
                "type": "array",
                "minItems": expected_count,
                "maxItems": expected_count,
                "items": evaluation,
            },
        },
    }


def batch_prompt(
    base_prompt: str,
    games: list[dict[str, Any]],
    model: str,
) -> str:
    payload = {
        "schemaVersion": 2,
        "rubricVersion": "steamguess-difficulty-v3",
        "games": games,
    }
    return (
        base_prompt.rstrip()
        + "\n\n## 本批次执行要求\n\n"
        + f"- 顶层 `model` 必须原样输出为 `{model}`。\n"
        + f"- 本批共有 {len(games)} 款游戏，必须逐款独立评估。\n"
        + "- `evaluations` 必须与输入 AppID 完全一致，不得遗漏、重复或新增。\n"
        + "- 只输出符合指定 JSON Schema 的 JSON。\n\n"
        + "## 本批输入\n\n"
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    )


def validate_result(
    payload: dict[str, Any],
    expected_games: list[dict[str, Any]],
    model: str,
) -> list[dict[str, Any]]:
    if payload.get("schemaVersion") != 2:
        raise ValueError("model returned an invalid schemaVersion")
    if payload.get("model") != model:
        raise ValueError(f"model field must be exactly {model!r}")
    if payload.get("rubricVersion") != "steamguess-difficulty-v3":
        raise ValueError("model returned an invalid rubricVersion")
    rows = payload.get("evaluations")
    if not isinstance(rows, list):
        raise ValueError("model output does not contain evaluations")

    expected = {int(game["appId"]) for game in expected_games}
    actual: list[int] = []
    for row in rows:
        if not isinstance(row, dict) or type(row.get("appId")) is not int:
            raise ValueError("evaluation contains an invalid AppID")
        appid = row["appId"]
        actual.append(appid)
        score = row.get("score")
        if type(score) is not int or not 0 <= score <= 100:
            raise ValueError(f"invalid score for AppID {appid}")
        if row.get("level") != level_for_score(score):
            raise ValueError(f"invalid level for AppID {appid}")
        if row.get("beginner") is not (score <= 14):
            raise ValueError(f"invalid beginner flag for AppID {appid}")
        confidence = row.get("confidence")
        if (
            not isinstance(confidence, (int, float))
            or isinstance(confidence, bool)
            or not 0 <= confidence <= 1
        ):
            raise ValueError(f"invalid confidence for AppID {appid}")
        eligible = row.get("eligible")
        exclusion_reason = row.get("exclusionReason")
        if type(eligible) is not bool:
            raise ValueError(f"invalid eligible flag for AppID {appid}")
        if eligible and exclusion_reason is not None:
            raise ValueError(f"eligible AppID {appid} has an exclusion reason")
        if not eligible and exclusion_reason not in VALID_EXCLUSION_REASONS:
            raise ValueError(f"excluded AppID {appid} has an invalid reason")
        reason = row.get("reason")
        if not isinstance(reason, str) or not reason.strip() or len(reason) > 60:
            raise ValueError(f"invalid reason for AppID {appid}")
        if row.get("reviewPriority") not in VALID_PRIORITIES:
            raise ValueError(f"invalid review priority for AppID {appid}")

    if len(actual) != len(set(actual)):
        raise ValueError("model output contains duplicate AppIDs")
    if set(actual) != expected:
        raise ValueError(
            f"model AppIDs differ: missing={sorted(expected - set(actual))} "
            f"extra={sorted(set(actual) - expected)}"
        )
    return rows


def invoke_codex(
    games: list[dict[str, Any]],
    *,
    prompt: str,
    model: str,
    reasoning_effort: str,
    timeout: float,
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="steamguess-difficulty-") as directory:
        root = Path(directory)
        schema_path = root / "schema.json"
        output_path = root / "output.json"
        schema_path.write_text(
            json.dumps(output_schema(len(games)), ensure_ascii=False),
            encoding="utf-8",
        )
        command = [
            os.environ.get("CODEX", "codex"),
            "exec",
            "-m",
            model,
            "-c",
            f'model_reasoning_effort="{reasoning_effort}"',
            "--ephemeral",
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "-C",
            "/tmp",
            "--output-schema",
            str(schema_path),
            "--output-last-message",
            str(output_path),
            "-",
        ]
        completed = subprocess.run(
            command,
            input=batch_prompt(prompt, games, model),
            text=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
        if completed.returncode != 0:
            error = completed.stderr.strip()
            raise RuntimeError(
                f"codex exited with {completed.returncode}: {error[-2000:]}"
            )
        return json.loads(output_path.read_text(encoding="utf-8"))


def checkpoint_path(directory: Path, index: int) -> Path:
    return directory / f"batch-{index:04d}.json"


def read_checkpoint(
    path: Path,
    games: list[dict[str, Any]],
    model: str,
) -> list[dict[str, Any]] | None:
    if not path.exists():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    return validate_result(payload, games, model)


def merged_payload(
    *,
    rows: list[dict[str, Any]],
    model: str,
    source: Path,
    seed: str,
    batch_size: int,
    complete: bool,
) -> dict[str, Any]:
    return {
        "schemaVersion": 2,
        "model": model,
        "rubricVersion": "steamguess-difficulty-v3",
        "source": str(source),
        "batchSize": batch_size,
        "batchSeed": seed,
        "complete": complete,
        "evaluations": sorted(rows, key=lambda row: int(row["appId"])),
    }


def run(
    args: argparse.Namespace,
    invoker: Callable[..., dict[str, Any]] = invoke_codex,
) -> int:
    if args.retries < 0 or args.delay < 0 or args.retry_delay < 0 or args.timeout <= 0:
        raise ValueError("invalid retry/delay/timeout arguments")
    source = load_input(args.input)
    rubric_version = source.get("rubricVersion")
    if rubric_version != "steamguess-difficulty-v3":
        raise ValueError(f"unsupported rubric version: {rubric_version!r}")
    prompt = args.prompt.read_text(encoding="utf-8")
    batches = make_batches(source["games"], args.batch_size, args.seed)
    selected_batches = batches[: args.limit_batches] if args.limit_batches else batches

    all_rows: list[dict[str, Any]] = []
    completed_batches = 0
    for index, games in enumerate(selected_batches):
        path = checkpoint_path(args.checkpoint_dir, index)
        rows = read_checkpoint(path, games, args.model) if args.resume else None
        if rows is not None:
            all_rows.extend(rows)
            completed_batches += 1
            print(
                f"batch={index + 1}/{len(selected_batches)} resumed games={len(games)}",
                flush=True,
            )
            continue

        last_error: Exception | None = None
        for attempt in range(args.retries + 1):
            try:
                result = invoker(
                    games,
                    prompt=prompt,
                    model=args.model,
                    reasoning_effort=args.reasoning_effort,
                    timeout=args.timeout,
                )
                rows = validate_result(result, games, args.model)
                atomic_write_json(path, result)
                all_rows.extend(rows)
                completed_batches += 1
                last_error = None
                break
            except (
                OSError,
                RuntimeError,
                ValueError,
                json.JSONDecodeError,
                subprocess.SubprocessError,
            ) as error:
                last_error = error
                if attempt < args.retries:
                    wait = args.retry_delay * (2**attempt)
                    print(
                        f"batch={index + 1}/{len(selected_batches)} "
                        f"retry={attempt + 1}/{args.retries} wait={wait:g}s "
                        f"error={error}",
                        flush=True,
                    )
                    time.sleep(wait)
        if last_error is not None:
            print(
                f"batch={index + 1}/{len(selected_batches)} failed={last_error}",
                flush=True,
            )
            break
        print(
            f"batch={index + 1}/{len(selected_batches)} games={len(games)} "
            f"complete={len(all_rows)}",
            flush=True,
        )
        if index + 1 < len(selected_batches):
            time.sleep(args.delay)

    complete = (
        completed_batches == len(batches)
        and len(all_rows) == len(source["games"])
    )
    atomic_write_json(
        args.out,
        merged_payload(
            rows=all_rows,
            model=args.model,
            source=args.input,
            seed=args.seed,
            batch_size=args.batch_size,
            complete=complete,
        ),
    )
    print(
        json.dumps(
            {
                "games": len(source["games"]),
                "evaluated": len(all_rows),
                "batches": len(batches),
                "completedBatches": completed_batches,
                "complete": complete,
                "model": args.model,
                "out": str(args.out),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    return 0 if complete or args.limit_batches else 2


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    result.add_argument("--prompt", type=Path, default=DEFAULT_PROMPT)
    result.add_argument("--out", type=Path, default=DEFAULT_OUT)
    result.add_argument("--checkpoint-dir", type=Path, default=DEFAULT_CHECKPOINT_DIR)
    result.add_argument("--model", default=DEFAULT_MODEL)
    result.add_argument(
        "--reasoning-effort",
        choices=("low", "medium", "high", "xhigh"),
        default="medium",
    )
    result.add_argument("--batch-size", type=int, default=20)
    result.add_argument("--seed", default="steamguess-difficulty-v3")
    result.add_argument("--limit-batches", type=int, default=0)
    result.add_argument("--delay", type=float, default=1.0)
    result.add_argument("--timeout", type=float, default=900.0)
    result.add_argument("--retries", type=int, default=2)
    result.add_argument("--retry-delay", type=float, default=15.0)
    result.add_argument("--resume", action="store_true")
    return result


def main() -> None:
    args = parser().parse_args()
    try:
        raise SystemExit(run(args))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"error: {error}") from error


if __name__ == "__main__":
    main()
