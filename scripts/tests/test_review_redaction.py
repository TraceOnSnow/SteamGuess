from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from scripts.catalog import import_review_redactions as importer
from scripts.catalog import redact_reviews_ai as redaction


class ReviewRedactionTests(unittest.TestCase):
    def make_catalog(self) -> dict:
        return {
            "games": [
                {
                    "appId": 10,
                    "name": "Example Game",
                    "localizedNames": {"zh": "示例游戏"},
                    "reviews": {
                        "english": [
                            {"reviewId": "r1", "text": "Meet Hero in Example Game."},
                            {"reviewId": "r2", "text": "A spoiler-free review."},
                        ],
                        "schinese": [{"reviewId": "r3", "text": "很喜欢示例游戏。"}],
                    },
                },
                {
                    "appId": 20,
                    "name": "Other Game",
                    "reviews": {"english": [{"reviewId": "r4", "text": "Other text."}]},
                },
            ]
        }

    def test_collect_tasks_filters_appids_and_language(self):
        tasks = redaction.collect_tasks(self.make_catalog(), {10}, "english")
        self.assertEqual([task.task_id for task in tasks], ["10:english:r1", "10:english:r2"])
        self.assertEqual(tasks[0].titles, ("Example Game", "示例游戏"))
        self.assertEqual(tasks[0].source_hash, sha256(tasks[0].text.encode()).hexdigest())

    def test_collect_tasks_applies_scope_and_per_language_limit_deterministically(self):
        tasks = redaction.collect_tasks(
            self.make_catalog(),
            None,
            "all",
            scope="active",
            active_limit=1,
            detail_limit=2,
            reviews_per_language=1,
        )
        self.assertEqual(
            [task.task_id for task in tasks],
            ["10:english:r1", "10:schinese:r3"],
        )
        detail = redaction.collect_tasks(
            self.make_catalog(),
            {20},
            "all",
            scope="detail",
            active_limit=1,
            detail_limit=2,
            reviews_per_language=1,
        )
        self.assertEqual([task.task_id for task in detail], ["20:english:r4"])

    def test_dry_run_writes_pending_jsonl_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            catalog = root / "catalog.json"
            output = root / "redactions.jsonl"
            catalog.write_text(json.dumps(self.make_catalog()), encoding="utf-8")
            with patch.object(redaction, "redact_with_model", side_effect=AssertionError("network called")):
                args = redaction.build_parser().parse_args([
                    "--catalog", str(catalog), "--out", str(output), "--dry-run", "--language", "english", "--limit", "2"
                ])
                exit_code = redaction.run(args)
            self.assertEqual(exit_code, 0)
            records = redaction.read_jsonl(output)
            self.assertEqual(len(records), 2)
            self.assertTrue(all(record["status"] == "pending" for record in records))
            self.assertEqual(records[0]["appId"], 10)
            self.assertEqual(records[0]["language"], "english")
            self.assertEqual(records[0]["reviewId"], "r1")
            self.assertEqual(records[0]["promptVersion"], redaction.PROMPT_VERSION)

    def test_jsonl_model_run_keeps_records_after_compaction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            catalog = root / "catalog.json"
            output = root / "redactions.jsonl"
            catalog.write_text(json.dumps(self.make_catalog()), encoding="utf-8")

            def fake_model(task, prompt, adapter):
                return task.text, []

            with patch.object(redaction, "redact_with_model", side_effect=fake_model):
                args = redaction.build_parser().parse_args(["--catalog", str(catalog), "--out", str(output), "--language", "english", "--limit", "2"])
                args.model = "test-model"
                self.assertEqual(redaction.run(args), 0)

            records = redaction.read_jsonl(output)
            self.assertEqual(len(records), 2)
            self.assertTrue(all(record["status"] == "ok" for record in records))

    def test_json_cache_is_atomic_and_resume_skips_completed_item(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            catalog = root / "catalog.json"
            output = root / "redactions.json"
            catalog.write_text(json.dumps(self.make_catalog()), encoding="utf-8")
            calls: list[str] = []

            def fake_model(task, prompt, adapter):
                calls.append(task.task_id)
                return task.text.replace("Example Game", "[游戏名]"), [{
                    "entity": "Example Game", "text": "Example Game", "replacement": "[游戏名]", "type": "title"
                }]

            with patch.object(redaction, "redact_with_model", side_effect=fake_model):
                args = redaction.build_parser().parse_args(["--catalog", str(catalog), "--out", str(output), "--language", "english", "--limit", "1"])
                args.model = "test-model"
                self.assertEqual(redaction.run(args), 0)
                resume_args = redaction.build_parser().parse_args(["--catalog", str(catalog), "--out", str(output), "--resume", "--language", "english", "--limit", "1"])
                resume_args.model = "test-model"
                self.assertEqual(redaction.run(resume_args), 0)
            self.assertEqual(calls, ["10:english:r1"])
            records = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]["status"], "ok")
            self.assertIn("redactedText", records[0])

    def test_jsonl_resume_repairs_partial_tail_and_keeps_last_result(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "redactions.jsonl"
            output.write_bytes(
                b'{"taskId":"10:english:r1","appId":10,"language":"english","reviewId":"r1","status":"pending"}\n'
                b'{"taskId":"10:english:r1","appId":10,"language":"english","reviewId":"r1","status":"ok"}\n'
                b'{"taskId":"broken"'
            )
            records = redaction.read_jsonl(output)
            self.assertEqual(len(records), 2)
            self.assertEqual(redaction.CheckpointStore(output, True).get("10:english:r1")["status"], "ok")
            self.assertEqual(output.read_bytes().count(b"broken"), 0)

    def test_normalize_model_result_requires_entity_fields(self):
        redacted, entities = redaction.normalize_model_result({
            "redactedText": "遇见[角色]",
            "entities": [{"entity": "Hero", "text": "Hero", "replacement": "[角色]", "type": "character"}],
        })
        self.assertEqual(redacted, "遇见[角色]")
        self.assertEqual(entities[0]["type"], "character")
        with self.assertRaises(redaction.ModelResponseError):
            redaction.normalize_model_result({"redactedText": "x", "entities": [{"text": "x"}]})

    def test_dry_run_never_imports_litellm(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            catalog = root / "catalog.json"
            output = root / "redactions.jsonl"
            catalog.write_text(json.dumps(self.make_catalog()), encoding="utf-8")
            args = redaction.build_parser().parse_args([
                "--catalog", str(catalog), "--out", str(output), "--dry-run", "--limit", "1"
            ])
            with patch.object(redaction.importlib, "import_module", side_effect=AssertionError("LiteLLM imported")):
                self.assertEqual(redaction.run(args), 0)

    def test_litellm_adapter_is_lazy_and_provider_agnostic(self):
        completion = Mock(return_value={
            "choices": [{
                "message": {
                    "content": json.dumps({
                        "redactedText": "Meet [角色名称].",
                        "entities": [{
                            "entity": "Hero",
                            "text": "Hero",
                            "replacement": "[角色名称]",
                            "type": "character",
                        }],
                    })
                }
            }]
        })
        module = SimpleNamespace(completion=completion)
        task = redaction.collect_tasks(self.make_catalog(), {10}, "english", limit=1)[0]
        adapter = redaction.LiteLLMAdapter(
            model="ollama/qwen2.5:3b",
            api_base="http://localhost:11434",
            timeout=12,
        )
        with patch.object(redaction.importlib, "import_module", return_value=module) as lazy_import:
            text, entities = adapter.redact(task, "prompt")
        lazy_import.assert_called_once_with("litellm")
        self.assertEqual(text, "Meet [角色名称].")
        self.assertEqual(entities[0]["entity"], "Hero")
        kwargs = completion.call_args.kwargs
        self.assertEqual(kwargs["model"], "ollama/qwen2.5:3b")
        self.assertEqual(kwargs["api_base"], "http://localhost:11434")
        self.assertEqual(kwargs["num_retries"], 0)

    def test_resume_reprocesses_changed_review_text(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            catalog = root / "catalog.json"
            output = root / "redactions.jsonl"
            payload = self.make_catalog()
            catalog.write_text(json.dumps(payload), encoding="utf-8")
            calls: list[str] = []

            def fake_model(task, prompt, adapter):
                calls.append(task.text)
                return task.text, []

            with patch.object(redaction, "redact_with_model", side_effect=fake_model):
                args = redaction.build_parser().parse_args([
                    "--catalog", str(catalog), "--out", str(output), "--model", "mock", "--limit", "1"
                ])
                self.assertEqual(redaction.run(args), 0)
                payload["games"][0]["reviews"]["english"][0]["text"] = "Changed review."
                catalog.write_text(json.dumps(payload), encoding="utf-8")
                resumed = redaction.build_parser().parse_args([
                    "--catalog", str(catalog), "--out", str(output), "--model", "mock", "--limit", "1", "--resume"
                ])
                self.assertEqual(redaction.run(resumed), 0)
            self.assertEqual(calls, ["Meet Hero in Example Game.", "Changed review."])
            records = redaction.read_jsonl(output)
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]["sourceHash"], sha256(b"Changed review.").hexdigest())


class ReviewRedactionImportTests(unittest.TestCase):
    def make_database(self, path: Path) -> None:
        connection = sqlite3.connect(path)
        with connection:
            connection.execute(
                """
                CREATE TABLE app_reviews (
                    appid INTEGER NOT NULL,
                    language TEXT NOT NULL,
                    review_id TEXT NOT NULL,
                    review_hash TEXT NOT NULL
                )
                """
            )
            text = "Meet Hero in Example Game."
            connection.execute(
                "INSERT INTO app_reviews VALUES (?, ?, ?, ?)",
                (10, "english", "r1", sha256(text.encode()).hexdigest()),
            )
        connection.close()

    def make_records(self) -> list[dict]:
        text = "Meet Hero in Example Game."
        return [
            {
                "taskId": "10:english:r1",
                "appId": 10,
                "language": "english",
                "reviewId": "r1",
                "sourceHash": sha256(text.encode()).hexdigest(),
                "redactedText": "Meet [角色名称] in [游戏名称].",
                "entities": [{"text": "Hero"}],
                "status": "ok",
                "model": "mock/model",
                "promptVersion": redaction.PROMPT_VERSION,
                "updatedAt": "2026-08-16T00:00:00Z",
            },
            {
                "taskId": "10:english:failed",
                "appId": 10,
                "language": "english",
                "reviewId": "failed",
                "sourceHash": "0" * 64,
                "redactedText": "",
                "entities": [],
                "status": "failed",
                "model": "mock/model",
                "promptVersion": redaction.PROMPT_VERSION,
                "updatedAt": "2026-08-16T00:00:00Z",
            },
        ]

    def test_import_creates_table_and_upserts_current_results(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "catalog.sqlite"
            checkpoint = root / "redactions.jsonl"
            self.make_database(database)
            checkpoint.write_text(
                "".join(json.dumps(item) + "\n" for item in self.make_records()),
                encoding="utf-8",
            )
            args = importer.build_parser().parse_args([
                "--input", str(checkpoint), "--db", str(database)
            ])
            stats = importer.run(args)
            self.assertEqual(stats["imported"], 1)
            self.assertEqual(stats["notOk"], 1)
            connection = sqlite3.connect(database)
            row = connection.execute(
                "SELECT redacted_text, model FROM review_redactions WHERE task_id = ?",
                ("10:english:r1",),
            ).fetchone()
            records = self.make_records()
            records[0]["redactedText"] = "Updated [游戏名称]."
            checkpoint.write_text(json.dumps(records[0]) + "\n", encoding="utf-8")
            importer.run(args)
            updated = connection.execute(
                "SELECT redacted_text FROM review_redactions WHERE task_id = ?",
                ("10:english:r1",),
            ).fetchone()
            connection.close()
            self.assertEqual(row, ("Meet [角色名称] in [游戏名称].", "mock/model"))
            self.assertEqual(updated, ("Updated [游戏名称].",))

    def test_import_skips_stale_review_and_dry_run_does_not_create_table(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "catalog.sqlite"
            checkpoint = root / "redactions.jsonl"
            self.make_database(database)
            records = self.make_records()
            records[0]["sourceHash"] = "f" * 64
            checkpoint.write_text(json.dumps(records[0]) + "\n", encoding="utf-8")
            args = importer.build_parser().parse_args([
                "--input", str(checkpoint), "--db", str(database), "--dry-run"
            ])
            stats = importer.run(args)
            self.assertEqual(stats["stale"], 1)
            connection = sqlite3.connect(database)
            self.assertFalse(importer.table_exists(connection, importer.TABLE))
            connection.close()


class CodexBatchTests(unittest.TestCase):
    def test_batches_stay_within_game_language_and_limits(self):
        from scripts.catalog.redact_reviews_ai import ReviewTask
        from scripts.catalog.redact_reviews_codex import make_batches
        tasks = [
            ReviewTask(f"1:english:{index}", 1, "english", str(index), "x" * 20, ("Game",), "0" * 64)
            for index in range(5)
        ] + [ReviewTask("1:schinese:1", 1, "schinese", "1", "中文", ("游戏",), "1" * 64)]
        batches = make_batches(tasks, batch_size=3, max_chars=1000)
        self.assertEqual([len(batch.tasks) for batch in batches], [3, 2, 1])
        self.assertTrue(all(len({(task.app_id, task.language) for task in batch.tasks}) == 1 for batch in batches))

    def test_codex_schema_requires_task_identity(self):
        from scripts.catalog.redact_reviews_codex import schema_payload
        schema = schema_payload()
        item = schema["properties"]["results"]["items"]
        self.assertIn("taskId", item["required"])
        self.assertIn("redactedText", item["required"])


if __name__ == "__main__":
    unittest.main()
