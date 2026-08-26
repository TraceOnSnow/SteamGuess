from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from scripts.catalog.database import connect, initialize
from scripts.catalog.update_difficulty_from_feedback import synchronize


class FeedbackDifficultyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.catalog = connect(Path(self.directory.name) / "catalog.sqlite")
        initialize(self.catalog)
        self.catalog.execute(
            """
            INSERT INTO apps(
                appid, canonical_name, created_at, updated_at
            ) VALUES (10, 'Test Game', '2026-08-16T00:00:00Z', '2026-08-16T00:00:00Z')
            """
        )
        self.catalog.execute(
            """
            INSERT INTO difficulty_ai_candidates(
                appid, score, level, confidence, reason, eligible,
                review_priority, model, prompt_version, evaluated_at, source_path
            ) VALUES (
                10, 40, 'normal', 0.8, 'test candidate', 1,
                'normal', 'test-ai', 'v3', '2026-08-16T00:00:00Z', 'test'
            )
            """
        )
        self.catalog.commit()
        self.runtime = sqlite3.connect(":memory:")
        self.runtime.row_factory = sqlite3.Row
        self.runtime.executescript(
            """
            CREATE TABLE game_sessions (
                id TEXT PRIMARY KEY, player_id TEXT, answer_app_id INTEGER,
                outcome TEXT, finished_at TEXT
            );
            CREATE TABLE difficulty_feedback (
                id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT,
                session_id TEXT, app_id INTEGER, score REAL, level TEXT,
                created_at TEXT
            );
            """
        )

    def tearDown(self) -> None:
        self.runtime.close()
        self.catalog.close()
        self.directory.cleanup()

    def add_feedback(self, player: int, score: float, *, appid: int = 10, valid: bool = True) -> None:
        player_id = f"player_{player:08d}"
        session_id = f"session_{player:08d}"
        self.runtime.execute(
            "INSERT INTO game_sessions VALUES (?, ?, ?, 'won', ?)",
            (session_id, player_id, appid if valid else 999, "2026-08-16T00:01:00Z"),
        )
        self.runtime.execute(
            """
            INSERT INTO difficulty_feedback(
                player_id, session_id, app_id, score, level, created_at
            ) VALUES (?, ?, ?, ?, 'hard', '2026-08-16T00:02:00Z')
            """,
            (player_id, session_id, appid, score),
        )

    def test_applies_shrunk_change_with_three_point_cap_and_is_idempotent(self) -> None:
        for player in range(10):
            self.add_feedback(player, 70)
        self.runtime.commit()

        result = synchronize(
            self.runtime,
            self.catalog,
            apply=True,
            now="2026-08-16T01:00:00Z",
        )
        self.assertEqual(result["applied"], 1)
        saved = self.catalog.execute(
            "SELECT current_score, candidate_score, sample_count, status FROM difficulty_feedback_scores WHERE appid = 10"
        ).fetchone()
        self.assertEqual(saved["current_score"], 43)
        self.assertEqual(saved["candidate_score"], 50)
        self.assertEqual(saved["sample_count"], 10)
        self.assertEqual(saved["status"], "applied")

        repeated = synchronize(self.runtime, self.catalog, apply=True)
        self.assertEqual(repeated["unchanged"], 1)
        self.assertEqual(
            self.catalog.execute("SELECT COUNT(*) FROM difficulty_feedback_history").fetchone()[0],
            1,
        )

    def test_uses_latest_feedback_per_player_and_rejects_high_disagreement(self) -> None:
        for player in range(10):
            self.add_feedback(player, 0 if player < 5 else 100)
        self.runtime.execute(
            """
            INSERT INTO difficulty_feedback(
                player_id, session_id, app_id, score, level, created_at
            ) VALUES ('player_00000000', 'session_00000000', 10, 100, 'hell', '2026-08-16T00:03:00Z')
            """
        )
        self.runtime.commit()
        result = synchronize(self.runtime, self.catalog, apply=True)
        self.assertEqual(result["review"], 1)
        saved = self.catalog.execute(
            "SELECT current_score, sample_count, status FROM difficulty_feedback_scores WHERE appid = 10"
        ).fetchone()
        self.assertIsNone(saved["current_score"])
        self.assertEqual(saved["sample_count"], 10)
        self.assertEqual(saved["status"], "review")

    def test_ignores_feedback_whose_session_answer_does_not_match(self) -> None:
        for player in range(10):
            self.add_feedback(player, 70, valid=player != 0)
        self.runtime.commit()
        result = synchronize(self.runtime, self.catalog, apply=True)
        self.assertEqual(result["insufficient"], 1)
        self.assertEqual(result["changes"][0]["sampleCount"], 9)

    def test_locked_editorial_score_never_changes(self) -> None:
        self.catalog.execute(
            """
            INSERT INTO difficulty_overrides(appid, manual_score, locked, updated_at)
            VALUES (10, 12, 1, '2026-08-16T00:00:00Z')
            """
        )
        self.catalog.commit()
        for player in range(10):
            self.add_feedback(player, 90)
        self.runtime.commit()
        result = synchronize(self.runtime, self.catalog, apply=True)
        self.assertEqual(result["locked"], 1)
        saved = self.catalog.execute(
            "SELECT current_score, status FROM difficulty_feedback_scores WHERE appid = 10"
        ).fetchone()
        self.assertIsNone(saved["current_score"])
        self.assertEqual(saved["status"], "locked")


if __name__ == "__main__":
    unittest.main()
