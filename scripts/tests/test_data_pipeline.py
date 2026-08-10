import json
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from scripts.catalog import discover_steamspy as catalog
from scripts.catalog import enrich_cn_prices as cn_prices
from scripts.catalog import enrich_storefront as localization
from scripts.catalog import fit_difficulty as regression
from scripts.catalog import publish_playable as publisher
from scripts.catalog import refresh_metrics as sample_peaks
from scripts.catalog import update_weekly
from scripts.catalog.database import initialize
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

    def test_normalize_filters_and_scores(self):
        payload = {
            "10": {"appid": 10, "name": "Known", "owners": "1000 .. 2000", "ccu": 20, "positive": 30},
            "11": {"appid": 11, "name": "Known Dedicated Server"},
            "12": {"appid": 12, "name": "Small", "owners": "0 .. 100", "negative": 2},
        }
        result = catalog.normalize([(0, payload, "2026-07-28T00:00:00Z", "test")])
        self.assertEqual(result["stats"]["accepted"], 2)
        self.assertEqual(result["stats"]["rejected"], 1)
        self.assertGreater(result["games"][0]["recognition"]["score"], result["games"][1]["recognition"]["score"])


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


class RegressionTests(unittest.TestCase):
    def test_fit_simple_line(self):
        rows = [[1.0, 0.0], [1.0, 1.0], [1.0, 2.0]]
        coefficients = regression.fit(rows, [0.0, 1.0, 2.0], ridge=0.000001)
        self.assertAlmostEqual(coefficients[0], 0.0, places=4)
        self.assertAlmostEqual(coefficients[1], 1.0, places=4)

    def test_level_boundaries(self):
        self.assertEqual(regression.level_for_score(0), "easy")
        self.assertEqual(regression.level_for_score(30), "normal")
        self.assertEqual(regression.level_for_score(60), "hard")
        self.assertEqual(regression.level_for_score(90), "hell")


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


class LocalizationTests(unittest.TestCase):
    def test_extracts_exact_localized_store_name(self):
        payload = {"1245620": {"success": True, "data": {"name": "艾尔登法环"}}}
        self.assertEqual(localization.extract_localized_name(payload, 1245620), "艾尔登法环")

    def test_rejects_unsuccessful_store_payload(self):
        self.assertIsNone(localization.extract_localized_name({"10": {"success": False}}, 10))

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

    def test_expands_playable_catalog_and_excludes_non_games(self):
        catalog = {"games": [
            {"appId": 10, "name": "Game", "type": "Game", "metrics": {}, "tags": []},
            {"appId": 20, "name": "Tool", "type": "Application", "metrics": {}, "tags": []},
        ]}
        result = publisher.build_playable_catalog(catalog, {})
        self.assertEqual(list(result), ["10"])
        self.assertEqual(result["10"]["releaseDate"], "")
        self.assertEqual(result["10"]["hints"], {})
        self.assertIn("/10/header.jpg", result["10"]["header_image"])

    def test_calibrates_all_published_games_to_reference_distribution(self):
        games = {
            str(appid): {
                "appId": appid,
                "difficultyScore": float(appid),
                "difficulty": {},
            }
            for appid in range(1, 998)
        }
        calibrated = publisher.calibrate_difficulty_distribution(games)
        counts = {
            level: sum(game["difficulty"]["level"] == level for game in calibrated.values())
            for level in ("easy", "normal", "hard", "hell")
        }
        self.assertEqual(counts, {"easy": 125, "normal": 207, "hard": 208, "hell": 457})
        self.assertEqual(len(calibrated), 997)

    def test_publishes_storefront_screenshot_hint(self):
        source = {"appId": 10, "name": "Game", "type": "game", "metrics": {}, "screenshots": [{"path": "https://example.test/shot.jpg"}]}
        result = publisher.build_game(source, {})
        self.assertEqual(result["hints"]["screenshotUrl"], "https://example.test/shot.jpg")

    def test_preserves_existing_screenshot_and_release_date(self):
        catalog = {"games": [{"appId": 10, "name": "Game", "type": "game", "metrics": {}, "tags": [], "difficulty": {"score": 42, "level": "normal", "source": "regression"}}]}
        previous = {"10": {
            "appId": 10,
            "releaseDate": "2020-01-01",
            "hints": {"screenshotUrl": "https://example.test/screenshot.jpg"},
            "tags": {"userTags": ["Puzzle"]},
        }}
        game = publisher.build_playable_catalog(catalog, previous)["10"]
        self.assertEqual(game["releaseDate"], "2020-01-01")
        self.assertEqual(game["hints"]["screenshotUrl"], "https://example.test/screenshot.jpg")
        self.assertEqual(game["tags"]["userTags"], ["Puzzle"])
        self.assertEqual(game["difficultyScore"], 42)
        self.assertEqual(game["difficulty"]["level"], "normal")


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
                "recognition": {"score": 50, "features": {}},
                "difficulty": {"score": 50, "level": "normal", "source": "heuristic", "excluded": False, "manualLevel": None},
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
            "hints": {"screenshotUrl": "https://example.test/shot.jpg"},
            "header_image": "https://example.test/header.jpg",
        }}
        labeling_payload = {"games": [{"appId": 10, "name": "Test Game"}], "generatedAt": "2026-07-30T00:00:00Z"}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = [root / "catalog.json", root / "playable.json", root / "labeling.json"]
            for path, payload in zip(paths, (catalog_payload, playable_payload, labeling_payload), strict=True):
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
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM app_media WHERE kind = 'screenshot'").fetchone()[0], 1)
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM catalog_memberships WHERE catalog = 'playable'").fetchone()[0], 1)
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM source_observations").fetchone()[0], 4)
            finally:
                connection.close()


if __name__ == "__main__":
    unittest.main()

class IncrementalWeeklyTests(unittest.TestCase):
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
                {"appId": 1, "name": "One", "type": "game", "localizedNames": {"zh": "一"}, "regionalPrices": {"cn": {"status": "free"}}},
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

    def test_review_loader_uses_loaded_catalog_objects(self):
        from scripts.catalog.enrich_reviews import load_games
        catalog = {"games": [{"appId": 730, "name": "CS2"}]}
        games = load_games(catalog)
        games[0]["reviews"] = {"english": []}
        self.assertIn("reviews", catalog["games"][0])

    def test_review_normalization_keeps_top_ten_shape(self):
        from scripts.catalog.enrich_reviews import normalize_reviews
        payload = {"reviews": [{"recommendationid": "r1", "review": "很好"}]}
        result = normalize_reviews(payload, "schinese", "2026-08-06T00:00:00Z")
        self.assertEqual(result[0]["reviewId"], "r1")
        self.assertEqual(result[0]["language"], "schinese")

    def test_review_checkpoint_is_atomic_and_resume_data_is_readable(self):
        from scripts.catalog.enrich_reviews import save_checkpoint
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "catalog.json"
            save_checkpoint(path, {"games": [{"appId": 1, "reviews": {"english": []}}]})
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["games"][0]["reviews"]["english"], [])
            self.assertFalse(list(Path(directory).glob(".*reviews-tmp-*")))

    def test_import_deduplicates_review_bodies(self):
        from scripts.catalog.import_current import import_catalog
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            catalog = root / "catalog.json"
            playable = root / "playable.json"
            labeling = root / "labeling.json"
            db = root / "catalog.sqlite"
            row = {"appId": 1, "name": "Test", "type": "game", "metrics": {}, "recognition": {"score": 1, "features": {}}, "reviews": {"english": [{"text": "same"}, {"text": "same"}, {"text": "other"}]}}
            catalog.write_text(json.dumps({"games": [row]}), encoding="utf-8")
            playable.write_text(json.dumps({"1": {"appId": 1, "name": "Test"}}), encoding="utf-8")
            labeling.write_text(json.dumps({"games": []}), encoding="utf-8")
            import_catalog(db, catalog, playable, labeling, 1)
            connection = sqlite3.connect(db)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM app_reviews").fetchone()[0], 2)
            connection.close()

    def test_import_persists_reviews_and_not_current_price(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); db = root / "catalog.sqlite"
            catalog = root / "catalog.json"; playable = root / "playable.json"; labeling = root / "labeling.json"
            game = {"appId": 1, "name": "Test", "type": "game", "metrics": {}, "recognition": {"score": 1, "features": {}}, "difficulty": {}, "regionalPrices": {"cn": {"status": "available", "currency": "CNY", "regularCents": 100, "currentCents": 1, "discountPercent": 99}}, "reviews": {"english": [{"text": "Good"}], "schinese": [{"text": "好"}]}}
            catalog.write_text(json.dumps({"games": [game]}), encoding="utf-8")
            playable.write_text("{}", encoding="utf-8"); labeling.write_text("{}", encoding="utf-8")
            from scripts.catalog.import_current import import_catalog
            import_catalog(db, catalog, playable, labeling, active_limit=1)
            connection = sqlite3.connect(db)
            price = connection.execute("SELECT regular_cents, current_cents, discount_percent FROM app_prices").fetchone()
            reviews = connection.execute("SELECT COUNT(*) FROM app_reviews").fetchone()[0]
            active = connection.execute("SELECT COUNT(*) FROM catalog_memberships WHERE catalog='active'").fetchone()[0]
            connection.close()
            self.assertEqual(price, (100, None, None))
            self.assertEqual(reviews, 2)
            self.assertEqual(active, 1)
