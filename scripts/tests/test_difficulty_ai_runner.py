from __future__ import annotations

import argparse
import json
import tempfile
import unittest
from pathlib import Path

from scripts.catalog.score_difficulty_ai_codex import (
    level_for_score,
    make_batches,
    run,
    validate_result,
)


def evaluation(appid: int, score: int = 50) -> dict:
    return {
        "appId": appid,
        "eligible": True,
        "exclusionReason": None,
        "score": score,
        "level": level_for_score(score),
        "beginner": score <= 14,
        "confidence": 0.8,
        "reason": "测试候选分",
        "reviewPriority": "normal",
    }


def result_for(games: list[dict], model: str) -> dict:
    return {
        "schemaVersion": 2,
        "model": model,
        "rubricVersion": "steamguess-difficulty-v3",
        "evaluations": [evaluation(game["appId"]) for game in games],
    }


class DifficultyAiRunnerTests(unittest.TestCase):
    def test_batches_are_deterministic_and_complete(self) -> None:
        games = [{"appId": appid} for appid in range(1, 54)]
        first = make_batches(games, 20, "seed")
        second = make_batches(games, 20, "seed")
        self.assertEqual(first, second)
        self.assertEqual([len(batch) for batch in first], [20, 20, 13])
        self.assertEqual(
            {game["appId"] for batch in first for game in batch},
            set(range(1, 54)),
        )
        self.assertNotEqual(first[0], games[:20])

    def test_validation_rejects_derived_field_mismatch(self) -> None:
        games = [{"appId": 10}]
        payload = result_for(games, "deepseek-v4-flash")
        payload["evaluations"][0]["level"] = "easy"
        with self.assertRaisesRegex(ValueError, "invalid level"):
            validate_result(payload, games, "deepseek-v4-flash")

    def test_resume_skips_completed_batches_and_merges_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "input.json"
            prompt_path = root / "prompt.md"
            out_path = root / "candidates.json"
            checkpoints = root / "checkpoints"
            games = [{"appId": appid, "name": f"Game {appid}"} for appid in range(1, 6)]
            input_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 2,
                        "rubricVersion": "steamguess-difficulty-v3",
                        "games": games,
                    }
                ),
                encoding="utf-8",
            )
            prompt_path.write_text("Prompt", encoding="utf-8")
            calls: list[list[int]] = []

            def fake_invoker(batch, **kwargs):
                calls.append([game["appId"] for game in batch])
                return result_for(batch, kwargs["model"])

            args = argparse.Namespace(
                input=input_path,
                prompt=prompt_path,
                out=out_path,
                checkpoint_dir=checkpoints,
                model="deepseek-v4-flash",
                reasoning_effort="medium",
                batch_size=2,
                seed="seed",
                limit_batches=0,
                delay=0,
                timeout=1,
                retries=0,
                retry_delay=0,
                resume=True,
            )
            self.assertEqual(run(args, fake_invoker), 0)
            self.assertEqual(len(calls), 3)
            calls.clear()
            self.assertEqual(run(args, fake_invoker), 0)
            self.assertEqual(calls, [])
            merged = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertTrue(merged["complete"])
            self.assertEqual(len(merged["evaluations"]), 5)


if __name__ == "__main__":
    unittest.main()
