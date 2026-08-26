from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from scripts.catalog.database import connect, initialize
from scripts.catalog.export_difficulty_ai_input import export_payload


class DifficultyAiInputTests(unittest.TestCase):
    def test_exports_objective_playable_metadata_without_score_leakage(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "catalog.sqlite"
            connection = connect(db_path)
            initialize(connection)
            connection.executescript(
                """
                INSERT INTO apps(
                  appid, canonical_name, app_type, release_date,
                  search_eligible, playable_eligible, excluded, created_at, updated_at
                ) VALUES (10, 'Example Game', 'game', '2026-01-01', 1, 1, 0, 'x', 'x');
                INSERT INTO catalog_memberships(catalog, appid, included_at, reason)
                VALUES ('playable', 10, 'x', 'test');
                INSERT INTO app_names(appid, locale, country, name, source, retrieved_at)
                VALUES (10, 'zh', 'cn', '示例游戏', 'storefront', 'x');
                INSERT INTO app_companies(appid, role, position, name, source, retrieved_at)
                VALUES (10, 'developer', 0, 'Example Studio', 'storefront', 'x');
                INSERT INTO app_tags(appid, source, position, name, retrieved_at)
                VALUES (10, 'pics', 0, 'RPG', 'x');
                INSERT INTO app_prices(
                  appid, country, currency, status, regular_cents,
                  current_cents, discount_percent, source, retrieved_at
                ) VALUES (10, 'cn', 'CNY', 'available', 6800, 3400, 50, 'storefront', 'x');
                INSERT INTO app_metrics(
                  appid, source, observed_at, ccu, owners_min, owners_max,
                  positive, negative, reviews_total, average_forever_minutes
                ) VALUES (10, 'steamspy', 'x', 100, 1000, 2000, 90, 10, 100, 120);
                INSERT INTO difficulty_overrides(appid, manual_score, locked, updated_at)
                VALUES (10, 1, 1, 'x');
                """
            )
            connection.commit()
            payload = export_payload(
                connection,
                scope="playable",
                generated_at="2026-08-14T00:00:00Z",
            )
            connection.close()

        self.assertEqual(payload["rubricVersion"], "steamguess-difficulty-v3")
        self.assertEqual(payload["count"], 1)
        game = payload["games"][0]
        self.assertEqual(game["localizedNames"]["zh-cn"], "示例游戏")
        self.assertEqual(game["tags"], ["RPG"])
        self.assertEqual(game["regularPriceCN"]["regularCents"], 6800)
        self.assertNotIn("currentCents", game["regularPriceCN"])
        self.assertEqual(game["steamspy"]["positiveRatio"], 0.9)
        self.assertFalse({"difficulty", "manualScore", "aiCandidateScore"} & game.keys())

    def test_skips_editorially_excluded_games(self) -> None:
        connection = sqlite3.connect(":memory:")
        connection.row_factory = sqlite3.Row
        initialize(connection)
        connection.executescript(
            """
            INSERT INTO apps(
              appid, canonical_name, search_eligible, playable_eligible,
              excluded, created_at, updated_at
            ) VALUES (10, 'Excluded Game', 1, 1, 0, 'x', 'x');
            INSERT INTO catalog_memberships(catalog, appid, included_at)
            VALUES ('playable', 10, 'x');
            INSERT INTO catalog_exclusions(appid, reason, created_at, updated_at)
            VALUES (10, 'too_obscure', 'x', 'x');
            """
        )
        payload = export_payload(connection, scope="playable")
        connection.close()
        self.assertEqual(payload["games"], [])


if __name__ == "__main__":
    unittest.main()
