import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.catalog import discover_steamspy
from scripts.catalog import publish_playable
from scripts.catalog import update_weekly
from scripts.catalog.database import initialize
from scripts.catalog.import_current import import_catalog
from scripts.catalog.migrate_catalog import migrate


def game_payload(app_id: int, name: str = "Game", **overrides):
    value = {
        "appId": app_id,
        "name": name,
        "type": "game",
        "releaseDate": "2020-01-01",
        "localizedNames": {"zh": "中文游戏"},
        "developers": ["Studio"],
        "publishers": ["Publisher"],
        "tags": [{"id": 1, "rank": 1, "name": "Action"}],
        "screenshots": [{"path": "https://cdn.example/screenshot.jpg"}],
        "regionalPrices": {
            "us": {"currency": "USD", "status": "available", "regularCents": 1999},
            "cn": {"currency": "CNY", "status": "available", "regularCents": 10800},
        },
        "metrics": {"ccu": 100, "reviewsTotal": 200},
        "reviews": {
            "english": [{"reviewId": "en-1", "text": "English review"}],
            "schinese": [{"reviewId": "zh-1", "text": "中文评论"}],
        },
        "rawSources": {"steamspy": {"source": "fixture"}},
    }
    value.update(overrides)
    return value


class DiscoveryTests(unittest.TestCase):
    def test_resume_uses_existing_raw_page_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw = root / "raw"
            raw.mkdir()
            (raw / "page_0_checkpoint.json").write_text(json.dumps({
                "page": 0,
                "retrievedAt": "2026-08-07T00:00:00Z",
                "transport": "checkpoint",
                "payload": {"1": {"appid": 1, "name": "Resumed", "owners": "1 .. 2"}},
            }), encoding="utf-8")
            output = root / "catalog.json"
            with patch.object(discover_steamspy, "fetch_page", side_effect=AssertionError("must resume")):
                with patch("sys.argv", [
                    "discover", "--pages", "0", "--raw-dir", str(raw),
                    "--resume", "--out", str(output),
                ]):
                    discover_steamspy.main()
            self.assertEqual(json.loads(output.read_text())["games"][0]["appId"], 1)

    def test_company_split_preserves_legal_suffixes(self):
        self.assertEqual(
            discover_steamspy.split_company_names(
                "FromSoftware, Inc., Bandai Namco Entertainment"
            ),
            ["FromSoftware, Inc.", "Bandai Namco Entertainment"],
        )

    def test_normalize_filters_non_games_and_keeps_order(self):
        result = discover_steamspy.normalize([(
            0,
            {
                "10": {"appid": 10, "name": "Known", "owners": "1000 .. 2000"},
                "11": {"appid": 11, "name": "Known Dedicated Server"},
            },
            "2026-07-28T00:00:00Z",
            "test",
        )])
        self.assertEqual([row["appId"] for row in result["games"]], [10])


class ConvergedCatalogTests(unittest.TestCase):
    def test_schema_has_one_business_table(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "catalog.sqlite"
            connection = sqlite3.connect(path)
            initialize(connection)
            tables = {
                row[0] for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            self.assertEqual(tables, {"games", "catalog_meta", "schema_migrations"})
            connection.close()

    def test_import_is_idempotent_preserves_raw_data_and_editorial_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db = root / "catalog.sqlite"
            catalog = root / "catalog.json"
            playable = root / "playable.json"
            catalog.write_text(json.dumps({"games": [game_payload(10)]}), encoding="utf-8")
            playable.write_text(json.dumps({"10": {"appId": 10}}), encoding="utf-8")

            import_catalog(db, catalog, playable, 1)
            connection = sqlite3.connect(db)
            connection.execute(
                "UPDATE games SET difficulty_score=80, difficulty_tier='hell', "
                "difficulty_manual_score=80, difficulty_locked=1, difficulty_source='manual_locked' "
                "WHERE appid=10"
            )
            connection.commit()
            connection.close()

            # A later partial snapshot must not erase expensive fields or the
            # manual editorial decision.
            catalog.write_text(json.dumps({"games": [{
                "appId": 10, "name": "Updated Name", "type": "game",
                "metrics": {"ccu": 250}, "tags": [], "screenshots": [],
                "reviews": {"english": [], "schinese": []},
            }]}), encoding="utf-8")
            import_catalog(db, catalog, playable, 1)

            connection = sqlite3.connect(db)
            row = connection.execute(
                "SELECT name_en, difficulty_score, difficulty_locked, "
                "developers_json, screenshot_urls_json, raw_sources_json "
                "FROM games WHERE appid=10"
            ).fetchone()
            self.assertEqual(row[0], "Updated Name")
            self.assertEqual(row[1:3], (80, 1))
            self.assertIn("Studio", row[3])
            self.assertIn("screenshot.jpg", row[4])
            self.assertIn("fixture", row[5])
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM games").fetchone()[0], 1)
            connection.close()

    def test_publish_uses_pool_status_and_only_publishes_authoritative_difficulty(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db = root / "catalog.sqlite"
            catalog = root / "catalog.json"
            output = root / "games.json"
            catalog.write_text(json.dumps({"games": [
                game_payload(1, "Playable"),
                game_payload(2, "Search only"),
                game_payload(3, "Excluded"),
            ]}), encoding="utf-8")
            playable = root / "ignored.json"
            playable.write_text("{}", encoding="utf-8")
            import_catalog(db, catalog, playable, 3)
            connection = sqlite3.connect(db)
            connection.execute(
                "UPDATE games SET difficulty_score=10, difficulty_tier='beginner', "
                "difficulty_source='manual' WHERE appid=1"
            )
            connection.execute(
                "UPDATE games SET pool_status='search_only', status_reason='too_obscure' WHERE appid=2"
            )
            connection.execute(
                "UPDATE games SET pool_status='excluded', status_reason='software' WHERE appid=3"
            )
            connection.commit()
            connection.close()

            publish_playable.publish(catalog, db, output, 0)
            published = json.loads(output.read_text())
            self.assertEqual(set(published), {"1", "2"})
            self.assertIn("difficulty", published["1"])
            self.assertNotIn("difficulty", published["2"])
            self.assertEqual(published["2"]["catalogStatus"], "search_only")

    def test_restore_cached_metadata_hydrates_partial_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db = root / "catalog.sqlite"
            catalog = root / "catalog.json"
            catalog.write_text(json.dumps({"games": [game_payload(10)]}), encoding="utf-8")
            import_catalog(db, catalog, root / "missing.json", 1)
            catalog.write_text(json.dumps({"games": [{
                "appId": 10, "name": "Game", "tags": [], "reviews": {},
            }]}), encoding="utf-8")
            restored = update_weekly.restore_cached_metadata(catalog, db)
            value = json.loads(catalog.read_text())["games"][0]
            self.assertEqual(restored, 1)
            self.assertEqual(value["localizedNames"]["zh"], "中文游戏")
            self.assertEqual(value["screenshots"][0]["path"], "https://cdn.example/screenshot.jpg")
            self.assertEqual(value["regionalPrices"]["cn"]["regularCents"], 10800)

    def test_migration_discards_legacy_difficulty_but_keeps_source_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "legacy.sqlite"
            output = root / "converged.sqlite"
            connection = sqlite3.connect(source)
            connection.executescript("""
                CREATE TABLE apps (
                    appid INTEGER PRIMARY KEY, canonical_name TEXT,
                    app_type TEXT, release_date TEXT,
                    pics_change_number INTEGER, excluded INTEGER DEFAULT 0
                );
                CREATE TABLE difficulty_ai_candidates (appid INTEGER PRIMARY KEY, score REAL);
                CREATE TABLE difficulty_overrides (appid INTEGER PRIMARY KEY, manual_score REAL);
                INSERT INTO apps VALUES (10, 'Legacy Game', 'game', '2019-01-01', 7, 0);
                INSERT INTO difficulty_ai_candidates VALUES (10, 99);
                INSERT INTO difficulty_overrides VALUES (10, 12);
            """)
            connection.commit()
            connection.close()
            catalog = root / "catalog.json"
            catalog.write_text(json.dumps({"games": [game_payload(10)]}), encoding="utf-8")
            raw = root / "raw"
            raw.mkdir()
            (raw / "page_0_fixture.json").write_text(json.dumps({
                "page": 0, "payload": {"10": {"appid": 10, "name": "Raw Game"}},
            }), encoding="utf-8")

            migrate(source, output, catalog, raw, None)
            connection = sqlite3.connect(output)
            tables = {
                row[0] for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            self.assertEqual(tables, {"games", "catalog_meta", "schema_migrations"})
            row = connection.execute(
                "SELECT name_en, release_date, pics_change_number, "
                "difficulty_score, raw_steamspy_json FROM games WHERE appid=10"
            ).fetchone()
            self.assertEqual(row[:3], ("Game", "2020-01-01", 7))
            self.assertIsNone(row[3])
            self.assertIn("Raw Game", row[4])
            connection.close()


if __name__ == "__main__":
    unittest.main()
