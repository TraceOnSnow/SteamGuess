import json
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from scripts.catalog import discover_steamspy as catalog
from scripts.catalog import enrich_cn_prices as cn_prices
from scripts.catalog import enrich_storefront as localization
from scripts.catalog import publish_playable as publisher
from scripts.catalog import review_redaction
from scripts.catalog import refresh_metrics as sample_peaks
from scripts.catalog import update_weekly
from scripts.catalog.database import SCHEMA_VERSION, initialize
from scripts.catalog.import_current import import_catalog
from scripts.legacy import convert_raw_jsonl as converter


class CatalogTests(unittest.TestCase):
    def test_discovery_resume_uses_existing_raw_page_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw = root / "raw"
            raw.mkdir()
            envelope = {"page": 0, "retrievedAt": "2026-08-07T00:00:00Z", "transport": "checkpoint", "payload": {"1": {"appid": 1, "name": "Resumed", "owners": "1 .. 2"}}}
            (raw / "page_0_checkpoint.json").write_text(json.dumps(envelope), encoding="utf-8")
            output = root / "catalog.json"
            with patch.object(catalog, "fetch_page", side_effect=AssertionError("resume must not fetch")), patch("sys.argv", ["discover", "--pages", "0", "--raw-dir", str(raw), "--resume", "--out", str(output)]):
                catalog.main()
            self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["games"][0]["appId"], 1)

    def test_decode_proxy_payload(self):
        payload = catalog.decode_payload("Title: x\n\nMarkdown Content:\n{\"1\": {\"appid\": 1}}")
        self.assertEqual(payload["1"]["appid"], 1)

    def test_parse_owners(self):
        self.assertEqual(catalog.parse_owners("1,000,000 .. 2,000,000"), (1_000_000, 2_000_000))

    def test_splits_steamspy_companies_and_preserves_legal_suffixes(self):
        self.assertEqual(
            catalog.split_company_names("FromSoftware, Inc., Bandai Namco Entertainment"),
            ["FromSoftware, Inc.", "Bandai Namco Entertainment"],
        )

    def test_normalize_filters_and_preserves_steamspy_order(self):
        payload = {
            "10": {"appid": 10, "name": "Known", "owners": "1000 .. 2000", "ccu": 20, "positive": 30},
            "11": {"appid": 11, "name": "Known Dedicated Server"},
            "12": {"appid": 12, "name": "Small", "owners": "0 .. 100", "negative": 2},
        }
        result = catalog.normalize([(0, payload, "2026-07-28T00:00:00Z", "test")])
        self.assertEqual(result["stats"]["accepted"], 2)
        self.assertEqual(result["stats"]["rejected"], 1)
        self.assertEqual([game["appId"] for game in result["games"]], [10, 12])
        self.assertNotIn("recognition", result["games"][0])


class DifficultyPublishingTests(unittest.TestCase):
    def test_active_window_is_fixed_before_difficulty_eligibility(self):
        source = {"games": [
            {"appId": 1, "name": "Editorial exclusion"},
            {"appId": 2, "name": "First active eligible"},
            {"appId": 3, "name": "Missing candidate"},
            {"appId": 4, "name": "Outside active eligible"},
        ]}
        candidates = {
            1: {"eligible": True},
            2: {"eligible": True},
            4: {"eligible": True},
        }
        selected = publisher.select_publishable_catalog(source, {1}, candidates, 2)
        self.assertEqual([game["appId"] for game in selected["games"]], [2, 3])

    def test_explicit_ai_ineligibility_is_hidden_from_search(self):
        source = {"games": [
            {"appId": 1, "name": "Game"},
            {"appId": 2, "name": "Software"},
            {"appId": 3, "name": "Unscored game"},
        ]}
        candidates = {
            1: {"eligible": True},
            2: {"eligible": False},
        }
        selected = publisher.select_publishable_catalog(source, set(), candidates, 3)
        self.assertEqual([game["appId"] for game in selected["games"]], [1, 3])

    def test_editorial_exclusion_is_removed_before_active_limit(self):
        source = {"games": [
            {"appId": 1, "name": "Editorial exclusion"},
            {"appId": 2, "name": "First replacement"},
            {"appId": 3, "name": "Second replacement"},
        ]}
        candidates = {
            1: {"eligible": True},
            2: {"eligible": True},
            3: {"eligible": True},
        }
        selected = publisher.select_publishable_catalog(source, {1}, candidates, 2)
        self.assertEqual([game["appId"] for game in selected["games"]], [2, 3])

    def test_effective_priority_is_locked_then_feedback_then_ai(self):
        games = {
            "10": {"appId": 10},
            "11": {"appId": 11},
            "12": {"appId": 12},
        }
        candidates = {
            10: {"score": 20, "level": "easy", "confidence": 0.8, "eligible": True},
            11: {"score": 30, "level": "normal", "confidence": 0.8, "eligible": True},
            12: {"score": 40, "level": "normal", "confidence": 0.8, "eligible": True},
        }
        publisher.apply_effective_difficulties(
            games,
            candidates,
            {12: {"manualScore": 80.0, "locked": True, "updatedAt": "now"}},
            {
                11: {"score": 60.0, "status": "applied", "sampleCount": 10},
                12: {"score": 70.0, "status": "applied", "sampleCount": 10},
            },
        )
        self.assertEqual(games["10"]["difficulty"]["source"], "ai-candidate")
        self.assertEqual(games["10"]["difficulty"]["score"], 20.0)
        self.assertEqual(games["11"]["difficulty"]["source"], "player-feedback")
        self.assertEqual(games["11"]["difficulty"]["score"], 60.0)
        self.assertEqual(games["12"]["difficulty"]["source"], "editorial-lock")
        self.assertEqual(games["12"]["difficulty"]["score"], 80.0)

    def test_catalog_import_preserves_ai_candidate_and_editorial_override(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db = root / "catalog.sqlite"
            catalog = root / "catalog.json"
            playable = root / "playable.json"
            catalog.write_text(json.dumps({"games": [{
                "appId": 10, "name": "Game", "type": "game", "metrics": {},
            }]}), encoding="utf-8")
            playable.write_text(json.dumps({"10": {"appId": 10, "name": "Game"}}), encoding="utf-8")
            import_catalog(db, catalog, playable, 1)
            connection = sqlite3.connect(db)
            connection.execute(
                """
                INSERT INTO difficulty_ai_candidates(
                    appid, score, level, confidence, reason, eligible,
                    review_priority, model, prompt_version, evaluated_at, source_path
                ) VALUES (10, 25, 'normal', 0.8, 'candidate', 1, 'normal', 'ai', 'v3', 'now', 'test')
                """
            )
            connection.execute("INSERT INTO difficulty_overrides VALUES (10, 80, 1, 'now')")
            connection.commit()
            connection.close()
            import_catalog(db, catalog, playable, 1)
            connection = sqlite3.connect(db)
            self.assertEqual(connection.execute("SELECT manual_score, locked FROM difficulty_overrides WHERE appid=10").fetchone(), (80.0, 1))
            self.assertEqual(connection.execute("SELECT score, eligible FROM difficulty_ai_candidates WHERE appid=10").fetchone(), (25, 1))
            self.assertNotIn(
                "app_scores",
                {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")},
            )
            connection.close()


class WeeklyCatalogTests(unittest.TestCase):
    def test_restores_pics_metadata_from_persistent_database(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "catalog.sqlite"
            connection = sqlite3.connect(database)
            try:
                initialize(connection)
                connection.execute(
                    """INSERT INTO apps(
                        appid, canonical_name, app_type, pics_change_number, created_at, updated_at
                    ) VALUES (10, 'Cached', 'game', 123, 'now', 'now')"""
                )
                connection.execute(
                    """INSERT INTO app_tags(
                        appid, source, position, tag_id, name, retrieved_at
                    ) VALUES (10, 'pics', 0, 19, 'Action', 'now')"""
                )
                connection.commit()
            finally:
                connection.close()
            catalog_path = root / "catalog.json"
            catalog_path.write_text(json.dumps({
                "games": [{
                    "appId": 10, "name": "Cached", "type": None,
                    "picsChangeNumber": None, "tags": [],
                    "sources": [], "fieldSources": {},
                }]
            }), encoding="utf-8")

            restored = update_weekly.restore_cached_pics(catalog_path, database)
            game = json.loads(catalog_path.read_text(encoding="utf-8"))["games"][0]
            self.assertEqual(restored, 1)
            self.assertEqual(game["type"], "game")
            self.assertEqual(game["picsChangeNumber"], 123)
            self.assertEqual(game["tags"], [{"id": 19, "rank": 1, "name": "Action"}])
            self.assertEqual(game["fieldSources"]["tags"], "pics")


class PlayableCatalogTests(unittest.TestCase):
    def test_uses_persistent_tag_cache_when_refreshed_catalog_has_no_tags(self):
        source = {
            "appId": 10,
            "name": "Cached Tags",
            "type": "game",
            "tags": [],
            "metrics": {},
            "developers": [],
            "publishers": [],
        }
        game = publisher.build_game(source, {}, ["Action", "RPG"])
        self.assertEqual(game["tags"]["userTags"], ["Action", "RPG"])

    def test_store_conversion_uses_regular_price_not_sale_price(self):
        store = {"data": {
            "name": "Sale Game",
            "price_overview": {"currency": "USD", "initial": 1999, "final": 399},
            "release_date": {"date": "1 Jan, 2020"},
        }}
        game = converter.build_game(10, store, {})
        self.assertEqual(game["price"]["us"]["regular"], 19.99)
        self.assertNotIn("current", game["price"]["us"])




class ReviewRedactionTests(unittest.TestCase):
    def test_redacts_title_localized_name_and_alias_without_touching_substrings(self):
        game = {
            "name": "Rust",
            "localizedNames": {"zh": "腐蚀"},
            "aliases": ["Rust Console Edition"],
        }
        text = "Rust is fun; Rusty Lake is a different series。腐蚀很好玩。"
        result = review_redaction.redact_review(text, game=game)
        self.assertEqual(result, "[游戏名称] is fun; Rusty Lake is a different series。[游戏名称]很好玩。")

    def test_redacts_characters_series_locations_and_companies(self):
        game = {
            "name": "Half-Life 2",
            "localizedNames": {"zh": "半条命2"},
            "developers": ["Valve"],
            "reviewEntities": {
                "characters": ["Gordon Freeman"],
                "series": ["Half-Life"],
                "locations": ["City 17"],
            },
        }
        text = "Gordon Freeman returns to City 17 in Half-Life. Valve did great work."
        result = review_redaction.redact_review(text, game=game)
        self.assertEqual(
            result,
            "[角色名称] returns to [地点名称] in [系列名称]. [厂商名称] did great work.",
        )

    def test_redacts_explicit_entity_list_and_prefers_longer_names(self):
        game = {
            "name": "Portal 2",
            "reviewEntities": [
                {"text": "Aperture Science", "kind": "franchise"},
                {"text": "Aperture", "kind": "location"},
            ],
        }
        result = review_redaction.redact_review(
            "Aperture Science and Aperture are both mentioned.", game=game
        )
        self.assertEqual(
            result,
            "[系列名称] and [地点名称] are both mentioned.",
        )

    def test_redact_game_reviews_preserves_raw_text_and_writes_version(self):
        game = {
            "appId": 10,
            "name": "Portal",
            "reviews": {"english": [{"text": "Portal is brilliant."}], "schinese": []},
        }
        changed = review_redaction.redact_game_reviews(game)
        item = game["reviews"]["english"][0]
        self.assertEqual(changed, 1)
        self.assertEqual(item["text"], "Portal is brilliant.")
        self.assertEqual(item["redactedText"], "[游戏名称] is brilliant.")
        self.assertEqual(item["redactionVersion"], review_redaction.REDACTION_VERSION)
        self.assertEqual(game["reviewRedactionVersion"], review_redaction.REDACTION_VERSION)

    def test_publisher_regenerates_hint_from_raw_review_and_entities(self):
        source = {
            "appId": 10,
            "name": "Portal",
            "localizedNames": {"zh": "传送门"},
            "developers": ["Valve"],
            "metrics": {},
            "reviews": {"english": [{"text": "Portal by Valve is brilliant."}]},
        }
        game = publisher.build_game(source, {})
        self.assertEqual(game["hints"]["reviewTexts"], ["[游戏名称] by [厂商名称] is brilliant."])

    def test_catalog_redaction_counts_only_non_empty_reviews(self):
        payload = {
            "games": [
                {"appId": 1, "name": "One", "reviews": {"english": [{"text": "One"}]}},
                {"appId": 2, "name": "Two", "reviews": {"english": [{"text": ""}]}},
            ]
        }
        result, games, reviews = review_redaction.redact_catalog(payload)
        self.assertIs(result, payload)
        self.assertEqual((games, reviews), (2, 1))

class LocalizationTests(unittest.TestCase):
    def test_extracts_exact_localized_store_name(self):
        payload = {"1245620": {"success": True, "data": {"name": "艾尔登法环"}}}
        self.assertEqual(localization.extract_localized_name(payload, 1245620), "艾尔登法环")

    def test_rejects_unsuccessful_store_payload(self):
        self.assertIsNone(localization.extract_localized_name({"10": {"success": False}}, 10))

    def test_fallback_country_title_is_not_used_as_primary_localized_name(self):
        self.assertIsNone(
            localization.primary_localized_name(
                {"us": {"name": "English fallback"}},
                "cn",
            )
        )
        self.assertEqual(
            localization.primary_localized_name(
                {
                    "cn": {"name": "中文标题"},
                    "us": {"name": "English fallback"},
                },
                "cn",
            ),
            "中文标题",
        )

    def test_extracts_storefront_rich_metadata(self):
        payload = {"10": {"success": True, "data": {
            "name": "丰富游戏",
            "type": "game",
            "release_date": {"date": "10 Oct, 2020"},
            "developers": ["FromSoftware, Inc."],
            "publishers": ["Bandai Namco Entertainment"],
            "header_image": "https://example.test/header.jpg",
            "screenshots": [{"id": 1, "path_full": "https://example.test/full.jpg", "path_thumbnail": "https://example.test/thumb.jpg"}],
        }}}
        details = localization.extract_storefront_details(payload, 10)
        self.assertEqual(details["type"], "game")
        self.assertEqual(details["releaseDate"], "10 Oct, 2020")
        self.assertEqual(details["developers"], ["FromSoftware, Inc."])
        self.assertEqual(details["publishers"], ["Bandai Namco Entertainment"])
        self.assertEqual(details["screenshots"][0]["path"], "https://example.test/full.jpg")

    def test_extracts_chinese_regular_price_not_sale_price(self):
        payload = {"10": {"success": True, "data": {
            "name": "测试游戏",
            "price_overview": {
                "currency": "CNY",
                "initial": 6800,
                "final": 3400,
                "discount_percent": 50,
            },
        }}}
        details = localization.extract_storefront_details(payload, 10)
        self.assertEqual(details["name"], "测试游戏")
        self.assertEqual(details["price"]["initialCents"], 6800)
        record = localization.regional_price_record(details, "cn", "2026-07-30T00:00:00Z")
        self.assertEqual(record["regularCents"], 6800)
        self.assertNotIn("currentCents", record)
        self.assertNotIn("discountPercent", record)

    def test_free_game_has_explicit_zero_price(self):
        details = {"name": "Free Game", "isFree": True, "price": None}
        record = localization.regional_price_record(details, "cn", "2026-07-30T00:00:00Z")
        self.assertEqual(record["status"], "free")
        self.assertEqual(record["regularCents"], 0)


class PublishCatalogTests(unittest.TestCase):
    def test_normalizes_combined_company_values_when_publishing(self):
        self.assertEqual(
            publisher.split_company_names(["FromSoftware, Inc., Bandai Namco Entertainment"]),
            ["FromSoftware, Inc.", "Bandai Namco Entertainment"],
        )

    def test_publishes_cn_regular_price_and_ignores_current_price(self):
        catalog_payload = {"games": [{
            "appId": 10,
            "metrics": {"initialPriceCents": 1999, "positive": 1, "negative": 0},
            "regionalPrices": {"cn": {
                "status": "available",
                "currency": "CNY",
                "regularCents": 6800,
                "currentCents": 3400,
            }},
        }]}
        playable_payload = [{
            "appId": 10,
            "price": {"us": {"currency": "USD", "regular": 19.99}},
            "popularity": {},
        }]
        publisher.publish(catalog_payload, playable_payload)
        self.assertEqual(playable_payload[0]["price"]["cn"], {"currency": "CNY", "regular": 68.0})
        self.assertNotIn("current", playable_payload[0]["price"]["cn"])

    def test_unavailable_cn_price_is_not_converted_from_usd(self):
        source = {"regionalPrices": {"cn": {"status": "unavailable"}}}
        self.assertEqual(publisher.published_cn_price(source), {})

    def test_publishes_selected_search_rows_without_trusting_pics_type(self):
        catalog = {"games": [
            {"appId": 10, "name": "Game", "type": "Game", "metrics": {}, "tags": []},
            {"appId": 20, "name": "Tool", "type": "Application", "metrics": {}, "tags": []},
        ]}
        result = publisher.build_playable_catalog(catalog, {})
        self.assertEqual(list(result), ["10", "20"])
        self.assertEqual(result["10"]["releaseDate"], "")
        self.assertEqual(result["10"]["hints"], {})
        self.assertIn("/10/header.jpg", result["10"]["header_image"])

    def test_publishes_all_storefront_screenshot_hints(self):
        source = {
            "appId": 10, "name": "Game", "type": "game", "metrics": {},
            "screenshots": [
                {"path": "https://example.test/one.jpg"},
                {"path": "https://example.test/two.jpg"},
                {"path": "https://example.test/one.jpg"},
            ],
        }
        result = publisher.build_game(source, {})
        self.assertEqual(result["hints"]["screenshotUrls"], [
            "https://example.test/one.jpg",
            "https://example.test/two.jpg",
        ])
        self.assertNotIn("screenshotUrl", result["hints"])

    def test_preserves_release_date_and_uses_catalog_screenshot_array(self):
        catalog = {"games": [{
            "appId": 10, "name": "Game", "type": "game", "metrics": {}, "tags": [],
            "screenshots": [{"path": "https://example.test/screenshot.jpg"}],
        }]}
        previous = {"10": {
            "appId": 10,
            "releaseDate": "2020-01-01",
            "tags": {"userTags": ["Puzzle"]},
        }}
        game = publisher.build_playable_catalog(catalog, previous)["10"]
        self.assertEqual(game["releaseDate"], "2020-01-01")
        self.assertEqual(game["hints"]["screenshotUrls"], ["https://example.test/screenshot.jpg"])
        self.assertEqual(game["tags"]["userTags"], ["Puzzle"])


class ChinaPriceBatchTests(unittest.TestCase):
    def test_extracts_only_cn_regular_prices(self):
        payload = {
            "10": {"success": True, "data": {"price_overview": {
                "currency": "CNY", "initial": 6800, "final": 3400, "discount_percent": 50,
            }}},
            "11": {"success": True, "data": []},
            "12": {"success": True, "data": {"price_overview": {
                "currency": "USD", "initial": 1000, "final": 1000,
            }}},
        }
        result = cn_prices.extract_cn_prices(payload, [10, 11, 12], "2026-07-30T00:00:00Z")
        self.assertEqual(result[10]["regularCents"], 6800)
        self.assertNotIn("currentCents", result[10])
        self.assertNotIn("discountPercent", result[10])
        self.assertNotIn(11, result)
        self.assertNotIn(12, result)


class PlayerPeakTests(unittest.TestCase):
    def test_rolling_peak_uses_recent_seven_days(self):
        from datetime import date
        days = {
            "2026-07-22": {"10": 999},
            "2026-07-24": {"10": 20},
            "2026-07-29": {"10": 80, "11": 5},
            "2026-07-30": {"10": 60},
        }
        metrics = sample_peaks.rolling_metrics(days, date(2026, 7, 30))
        self.assertEqual(metrics["10"], {"peak7d": 80, "peak7dSamples": 3})
        self.assertEqual(metrics["11"], {"peak7d": 5, "peak7dSamples": 1})

    def test_updates_catalog_and_playable_shapes(self):
        sample = {"10": 40}
        rolling = {"10": {"peak7d": 90, "peak7dSamples": 4}}
        catalog_payload = {"games": [{"appId": 10, "metrics": {"ccu": 1}}]}
        playable_payload = [{"appId": 10, "popularity": {"ccu": 1}}]
        sample_peaks.update_catalog(catalog_payload, sample, rolling)
        sample_peaks.update_catalog(playable_payload, sample, rolling)
        self.assertEqual(catalog_payload["games"][0]["metrics"]["peak7d"], 90)
        self.assertEqual(playable_payload[0]["popularity"]["peakYesterday"], 40)


class CatalogDatabaseTests(unittest.TestCase):
    def test_schema_enforces_unique_appid_and_keeps_source_metadata(self):
        connection = sqlite3.connect(":memory:")
        try:
            initialize(connection)
            connection.execute(
                "INSERT INTO apps(appid, canonical_name, created_at, updated_at) VALUES (10, 'Game', 'now', 'now')"
            )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO apps(appid, canonical_name, created_at, updated_at) VALUES (10, 'Duplicate', 'now', 'now')"
                )
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            self.assertIn("source_observations", tables)
            self.assertIn("enrichment_jobs", tables)
        finally:
            connection.close()

    def test_removes_obsolete_derived_scores_during_migration(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "catalog.sqlite"
            connection = sqlite3.connect(database)
            connection.executescript(
                """
                PRAGMA foreign_keys = ON;
                CREATE TABLE schema_migrations (
                    version INTEGER PRIMARY KEY,
                    applied_at TEXT NOT NULL
                );
                CREATE TABLE apps (
                    appid INTEGER PRIMARY KEY CHECK (appid > 0),
                    canonical_name TEXT NOT NULL,
                    app_type TEXT,
                    release_date TEXT,
                    pics_change_number INTEGER,
                    search_eligible INTEGER NOT NULL DEFAULT 0,
                    playable_eligible INTEGER NOT NULL DEFAULT 0,
                    excluded INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE app_scores (appid INTEGER PRIMARY KEY, stale_value REAL);
                CREATE TABLE difficulty_ai_candidates (
                    appid INTEGER PRIMARY KEY REFERENCES apps(appid) ON DELETE CASCADE,
                    score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
                    level TEXT NOT NULL CHECK (level IN ('easy', 'normal', 'hard', 'hell')),
                    confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
                    reason TEXT NOT NULL,
                    eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
                    exclusion_reason TEXT,
                    review_priority TEXT NOT NULL CHECK (review_priority IN ('high', 'normal', 'low')),
                    model TEXT NOT NULL,
                    prompt_version TEXT NOT NULL,
                    evaluated_at TEXT NOT NULL,
                    source_path TEXT NOT NULL
                );
                CREATE TABLE review_redactions (
                    task_id TEXT PRIMARY KEY,
                    appid INTEGER NOT NULL,
                    language TEXT NOT NULL,
                    review_id TEXT NOT NULL,
                    review_hash TEXT NOT NULL,
                    redacted_text TEXT NOT NULL,
                    entities_json TEXT NOT NULL,
                    model TEXT NOT NULL,
                    prompt_version TEXT NOT NULL,
                    processed_at TEXT NOT NULL,
                    imported_at TEXT NOT NULL,
                    source_path TEXT NOT NULL
                );
                INSERT INTO schema_migrations VALUES
                    (1, 'old'), (2, 'old'), (3, 'old'), (4, 'old'),
                    (5, 'old'), (6, 'old'), (7, 'old');
                INSERT INTO apps(
                    appid, canonical_name, created_at, updated_at
                ) VALUES (10, 'Legacy Game', 'old', 'old');
                INSERT INTO app_scores VALUES (10, 90);
                INSERT INTO difficulty_ai_candidates VALUES (
                    10, 65, 'hard', 0.75, 'legacy candidate', 1, NULL,
                    'normal', 'legacy-model', 'v1', 'old', 'legacy.jsonl'
                );
                INSERT INTO review_redactions VALUES (
                    '10:english:r1', 10, 'english', 'r1', 'hash',
                    '[游戏名称] is good.', '[]', 'legacy-model', 'v1',
                    'old', 'old', 'legacy.jsonl'
                );
                """
            )

            initialize(connection)

            self.assertEqual(
                connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0],
                SCHEMA_VERSION,
            )
            self.assertNotIn(
                "app_scores",
                {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")},
            )
            self.assertEqual(
                connection.execute(
                    "SELECT score, level FROM difficulty_ai_candidates WHERE appid=10"
                ).fetchone(),
                (65, "hard"),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT redacted_text FROM review_redactions WHERE task_id='10:english:r1'"
                ).fetchone()[0],
                "[游戏名称] is good.",
            )
            connection.execute(
                "UPDATE difficulty_ai_candidates SET score=10, level='beginner' WHERE appid=10"
            )
            connection.commit()
            connection.close()

    def test_import_merges_rich_playable_fields_and_is_idempotent(self):
        catalog_payload = {
            "generatedAt": "2026-07-30T00:00:00Z",
            "games": [{
                "appId": 10,
                "name": "Test Game",
                "type": "Game",
                "releaseDate": None,
                "developers": ["Studio, Inc."],
                "publishers": ["Studio, Inc., Publisher"],
                "tags": [{"id": 1, "rank": 1, "name": "Puzzle"}],
                "metrics": {"ccu": 2, "ownersMin": 10, "ownersMax": 20, "positive": 3, "negative": 1, "reviewsTotal": 4},
                "localizedNames": {"zh": "测试游戏"},
                "regionalPrices": {"cn": {"status": "available", "currency": "CNY", "regularCents": 6800, "currentCents": 3400, "discountPercent": 50, "retrievedAt": "2026-07-30T00:00:00Z"}},
                "picsChangeNumber": 123,
                "sources": [
                    {"service": "steamspy", "endpoint": "request=all&page=0", "retrievedAt": "2026-07-30T00:00:00Z"},
                    {"service": "pics", "endpoint": "PICS ProductInfo", "retrievedAt": "2026-07-30T00:00:00Z"},
                    {"service": "storefront", "endpoint": "appdetails", "retrievedAt": "2026-07-30T00:00:00Z"},
                ],
                "fieldSources": {"tags": "pics", "developers": "steamspy", "publishers": "steamspy"},
            }],
        }
        playable_payload = {"10": {
            "appId": 10,
            "name": "Test Game",
            "releaseDate": "2020-01-01",
            "price": {"us": {"currency": "USD", "regular": 19.99}},
            "hints": {"screenshotUrls": ["https://example.test/one.jpg", "https://example.test/two.jpg"]},
            "header_image": "https://example.test/header.jpg",
            "difficulty": {"score": 35, "level": "normal"},
        }}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = [root / "catalog.json", root / "playable.json"]
            for path, payload in zip(paths, (catalog_payload, playable_payload), strict=True):
                path.write_text(json.dumps(payload), encoding="utf-8")
            database = root / "catalog.sqlite"
            first = import_catalog(database, *paths)
            second = import_catalog(database, *paths)
            self.assertEqual(first["apps"], 1)
            self.assertEqual(second["apps"], 1)
            connection = sqlite3.connect(database)
            try:
                self.assertEqual(connection.execute("SELECT release_date FROM apps WHERE appid = 10").fetchone()[0], "2020-01-01")
                self.assertEqual(connection.execute("SELECT name FROM app_companies WHERE role = 'publisher' ORDER BY position").fetchall(), [("Studio, Inc.",), ("Publisher",)])
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM app_media WHERE kind = 'screenshot'").fetchone()[0], 2)
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM catalog_memberships WHERE catalog = 'playable'").fetchone()[0], 1)
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM source_observations").fetchone()[0], 4)
                self.assertIsNone(connection.execute(
                    "SELECT payload_json FROM source_observations WHERE service = 'catalog-import'"
                ).fetchone()[0])
            finally:
                connection.close()

    def test_import_replaces_catalog_snapshot_observations_across_staging_paths(self):
        payload = {"games": [{
            "appId": 10, "name": "Game", "type": "game", "metrics": {},
        }]}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            playable = root / "playable.json"
            playable.write_text("{}", encoding="utf-8")
            first = root / "first" / "catalog.json"
            second = root / "second" / "catalog.json"
            first.parent.mkdir()
            second.parent.mkdir()
            first.write_text(json.dumps(payload), encoding="utf-8")
            second.write_text(json.dumps(payload), encoding="utf-8")
            database = root / "catalog.sqlite"
            import_catalog(database, first, playable, 1)
            import_catalog(database, second, playable, 1)
            connection = sqlite3.connect(database)
            try:
                rows = connection.execute(
                    "SELECT endpoint, payload_json FROM source_observations WHERE service = 'catalog-import'"
                ).fetchall()
                self.assertEqual(rows, [(str(second), None)])
            finally:
                connection.close()


if __name__ == "__main__":
    unittest.main()

class IncrementalWeeklyTests(unittest.TestCase):
    def test_plan_skips_editorial_exclusions_and_promotes_next_ranked_game(self):
        from scripts.catalog.update_weekly import build_plan
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db = root / "catalog.sqlite"
            catalog_path = root / "catalog.json"
            catalog_path.write_text(json.dumps({"games": [
                {"appId": 1, "name": "Excluded"},
                {"appId": 2, "name": "Second"},
                {"appId": 3, "name": "Replacement"},
                {"appId": 4, "name": "Reserve"},
            ]}), encoding="utf-8")
            connection = sqlite3.connect(db)
            initialize(connection)
            for appid in range(1, 5):
                connection.execute(
                    "INSERT INTO apps(appid, canonical_name, created_at, updated_at) VALUES (?, ?, 'x', 'x')",
                    (appid, f"Game {appid}"),
                )
            connection.execute(
                "INSERT INTO catalog_exclusions(appid, reason, created_at, updated_at) VALUES (1, 'unsuitable', 'x', 'x')"
            )
            connection.commit()
            connection.close()
            plan = build_plan(db, catalog_path, active_limit=2)
            self.assertEqual(plan.active_appids, (2, 3))
            self.assertEqual(plan.reserve_appids, (4,))

    def test_plan_requeues_storefront_when_job_is_complete_but_fields_are_missing(self):
        from scripts.catalog.update_weekly import build_plan
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            catalog = root / "catalog.json"
            db = root / "catalog.sqlite"
            catalog.write_text(json.dumps({"games": [
                {"appId": 1, "name": "Missing storefront", "type": None},
                {"appId": 2, "name": "Complete", "type": "game", "localizedNames": {"zh": "完整"}, "regionalPrices": {"cn": {"status": "free"}}},
            ]}), encoding="utf-8")
            connection = sqlite3.connect(db)
            initialize(connection)
            for appid in (1, 2):
                connection.execute("INSERT INTO apps(appid, canonical_name, created_at, updated_at) VALUES (?, ?, 'x', 'x')", (appid, f"Game {appid}"))
                connection.execute("INSERT INTO enrichment_jobs(appid, service, locale, country, status, updated_at) VALUES (?, 'storefront', 'schinese', 'cn', 'complete', 'x')", (appid,))
            connection.commit(); connection.close()
            plan = build_plan(db, catalog, active_limit=2)
            self.assertEqual(plan.missing_storefront, (1,))

    def test_plan_separates_active_reserve_and_only_new_enrichment(self):
        from scripts.catalog.update_weekly import build_plan
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db = root / "catalog.sqlite"
            catalog_path = root / "catalog.json"
            catalog_path.write_text(json.dumps({"games": [
                {"appId": 1, "name": "One", "type": "game", "localizedNames": {"zh": "一"}, "regionalPrices": {"cn": {"status": "free"}}, "reviewFetchLimits": {"english": 100, "schinese": 100}},
                {"appId": 2, "name": "Two"},
                {"appId": 3, "name": "Three"},
            ]}), encoding="utf-8")
            connection = sqlite3.connect(db)
            initialize(connection)
            connection.execute("INSERT INTO apps(appid, canonical_name, created_at, updated_at) VALUES (1, 'One', 'x', 'x')")
            connection.execute("INSERT INTO catalog_memberships(catalog, appid, included_at) VALUES ('active', 1, 'x')")
            connection.execute("INSERT INTO enrichment_jobs(appid, service, locale, country, status, updated_at) VALUES (1, 'storefront', 'schinese', 'cn', 'complete', 'x')")
            connection.execute("INSERT INTO enrichment_jobs(appid, service, locale, country, status, updated_at) VALUES (1, 'pics', '', '', 'complete', 'x')")
            connection.execute("INSERT INTO enrichment_jobs(appid, service, locale, country, status, updated_at) VALUES (1, 'reviews', 'english', '', 'complete', 'x')")
            connection.execute("INSERT INTO enrichment_jobs(appid, service, locale, country, status, updated_at) VALUES (1, 'reviews', 'schinese', '', 'complete', 'x')")
            connection.commit(); connection.close()
            plan = build_plan(db, catalog_path, active_limit=2)
            self.assertEqual(plan.active_appids, (1, 2))
            self.assertEqual(plan.reserve_appids, (3,))
            self.assertEqual(plan.new_active_appids, (2,))
            self.assertEqual(plan.missing_storefront, (2,))
            self.assertEqual(plan.missing_pics, (2,))
            self.assertEqual(plan.missing_reviews, (2,))

    def test_plan_enriches_detail_window_without_expanding_active_pool(self):
        from scripts.catalog.update_weekly import build_plan
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db = root / "catalog.sqlite"
            catalog_path = root / "catalog.json"
            catalog_path.write_text(json.dumps({"games": [
                {"appId": appid, "name": f"Game {appid}"}
                for appid in range(1, 7)
            ]}), encoding="utf-8")
            connection = sqlite3.connect(db)
            initialize(connection)
            for appid in range(1, 7):
                connection.execute(
                    "INSERT INTO apps(appid, canonical_name, created_at, updated_at) VALUES (?, ?, 'x', 'x')",
                    (appid, f"Game {appid}"),
                )
            connection.execute(
                "INSERT INTO catalog_exclusions(appid, reason, created_at, updated_at) VALUES (2, 'unsuitable', 'x', 'x')"
            )
            connection.commit()
            connection.close()

            plan = build_plan(db, catalog_path, active_limit=2, detail_limit=4)
            self.assertEqual(plan.active_appids, (1, 3))
            self.assertEqual(plan.detail_appids, (1, 3, 4, 5))
            self.assertEqual(plan.missing_pics, (1, 3, 4, 5))
            self.assertEqual(plan.reserve_appids, (4, 5, 6))

    def test_plan_requeues_reviews_when_previous_snapshot_only_fetched_ten(self):
        from scripts.catalog.update_weekly import build_plan
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db = root / "catalog.sqlite"
            catalog_path = root / "catalog.json"
            catalog_path.write_text(json.dumps({"games": [{
                "appId": 1,
                "name": "One",
                "reviewFetchLimits": {"english": 10, "schinese": 10},
                "reviews": {"english": [], "schinese": []},
            }]}), encoding="utf-8")
            connection = sqlite3.connect(db)
            initialize(connection)
            connection.execute("INSERT INTO apps(appid, canonical_name, created_at, updated_at) VALUES (1, 'One', 'x', 'x')")
            for language in ("english", "schinese"):
                connection.execute(
                    "INSERT INTO enrichment_jobs(appid, service, locale, country, status, updated_at) VALUES (1, 'reviews', ?, '', 'complete', 'x')",
                    (language,),
                )
            connection.commit()
            connection.close()
            self.assertEqual(build_plan(db, catalog_path, active_limit=1).missing_reviews, (1,))

    def test_review_loader_uses_loaded_catalog_objects(self):
        from scripts.catalog.enrich_reviews import load_games
        catalog = {"games": [{"appId": 730, "name": "CS2"}]}
        games = load_games(catalog)
        games[0]["reviews"] = {"english": []}
        self.assertIn("reviews", catalog["games"][0])

    def test_review_normalization_keeps_up_to_one_hundred_without_ranking_filter(self):
        from scripts.catalog.enrich_reviews import normalize_reviews
        payload = {"reviews": [
            {"recommendationid": f"r{index}", "review": f"review {index}"}
            for index in range(120)
        ]}
        result = normalize_reviews(payload, "schinese", "2026-08-06T00:00:00Z")
        self.assertEqual(len(result), 100)
        self.assertEqual(result[0]["reviewId"], "r0")
        self.assertEqual(result[-1]["reviewId"], "r99")
        self.assertEqual(result[0]["language"], "schinese")

    def test_review_checkpoint_is_atomic_and_resume_data_is_readable(self):
        from scripts.catalog.enrich_reviews import save_checkpoint
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "catalog.json"
            save_checkpoint(path, {"games": [{"appId": 1, "reviews": {"english": []}}]})
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["games"][0]["reviews"]["english"], [])
            self.assertFalse(list(Path(directory).glob(".*reviews-tmp-*")))

    def test_schema_migration_expands_review_positions_to_one_hundred(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory) / "catalog.sqlite"
            connection = sqlite3.connect(db)
            initialize(connection)
            connection.execute("INSERT INTO apps(appid, canonical_name, created_at, updated_at) VALUES (1, 'One', 'x', 'x')")
            for position in range(1, 101):
                connection.execute(
                    """INSERT INTO app_reviews(
                        appid, language, position, review_id, review_text, source, retrieved_at, review_hash
                    ) VALUES (1, 'english', ?, ?, ?, 'steamreviews', 'x', ?)""",
                    (position, f"r{position}", f"review {position}", f"hash{position}"),
                )
            connection.commit()
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM app_reviews").fetchone()[0], 100)
            connection.close()

    def test_import_deduplicates_review_bodies(self):
        from scripts.catalog.import_current import import_catalog
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            catalog = root / "catalog.json"
            playable = root / "playable.json"
            db = root / "catalog.sqlite"
            row = {"appId": 1, "name": "Test", "type": "game", "metrics": {}, "reviews": {"english": [{"text": "same"}, {"text": "same"}, {"text": "other"}]}}
            catalog.write_text(json.dumps({"games": [row]}), encoding="utf-8")
            playable.write_text(json.dumps({"1": {"appId": 1, "name": "Test"}}), encoding="utf-8")
            import_catalog(db, catalog, playable, 1)
            connection = sqlite3.connect(db)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM app_reviews").fetchone()[0], 2)
            connection.close()

    def test_import_persists_reviews_and_not_current_price(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); db = root / "catalog.sqlite"
            catalog = root / "catalog.json"; playable = root / "playable.json"
            game = {"appId": 1, "name": "Test", "type": "game", "metrics": {}, "regionalPrices": {"cn": {"status": "available", "currency": "CNY", "regularCents": 100, "currentCents": 1, "discountPercent": 99}}, "reviews": {"english": [{"text": "Good"}], "schinese": [{"text": "好"}]}}
            catalog.write_text(json.dumps({"games": [game]}), encoding="utf-8")
            playable.write_text("{}", encoding="utf-8")
            from scripts.catalog.import_current import import_catalog
            import_catalog(db, catalog, playable, active_limit=1)
            connection = sqlite3.connect(db)
            price = connection.execute("SELECT regular_cents, current_cents, discount_percent FROM app_prices").fetchone()
            reviews = connection.execute("SELECT COUNT(*) FROM app_reviews").fetchone()[0]
            active = connection.execute("SELECT COUNT(*) FROM catalog_memberships WHERE catalog='active'").fetchone()[0]
            connection.close()
            self.assertEqual(price, (100, None, None))
            self.assertEqual(reviews, 2)
            self.assertEqual(active, 1)

    def test_import_preserves_editorial_exclusion_and_replaces_active_slot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db = root / "catalog.sqlite"
            catalog = root / "catalog.json"
            playable = root / "playable.json"
            games = [
                {"appId": appid, "name": f"Game {appid}", "type": "game", "metrics": {}}
                for appid in (1, 2, 3)
            ]
            catalog.write_text(json.dumps({"games": games}), encoding="utf-8")
            playable.write_text(json.dumps({
                str(appid): {
                    "appId": appid,
                    "name": f"Game {appid}",
                    "difficulty": {"score": 35, "level": "normal"},
                }
                for appid in (1, 2, 3)
            }), encoding="utf-8")
            connection = sqlite3.connect(db)
            initialize(connection)
            connection.execute(
                "INSERT INTO apps(appid, canonical_name, created_at, updated_at) VALUES (1, 'Game 1', 'x', 'x')"
            )
            connection.execute(
                "INSERT INTO catalog_exclusions(appid, reason, created_at, updated_at) VALUES (1, 'too_obscure', 'x', 'x')"
            )
            connection.commit()
            connection.close()

            from scripts.catalog.import_current import import_catalog
            import_catalog(db, catalog, playable, active_limit=2)
            connection = sqlite3.connect(db)
            try:
                active_ids = {
                    row[0] for row in connection.execute(
                        "SELECT appid FROM catalog_memberships WHERE catalog='active'"
                    )
                }
                playable_ids = {
                    row[0] for row in connection.execute(
                        "SELECT appid FROM catalog_memberships WHERE catalog='playable'"
                    )
                }
                self.assertEqual(active_ids, {2, 3})
                self.assertEqual(playable_ids, {2, 3})
                self.assertEqual(
                    connection.execute("SELECT reason FROM catalog_exclusions WHERE appid=1").fetchone()[0],
                    "too_obscure",
                )
            finally:
                connection.close()
