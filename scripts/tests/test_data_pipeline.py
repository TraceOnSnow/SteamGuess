import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from scripts.catalog import discover_steamspy as catalog
from scripts.catalog import enrich_cn_prices as cn_prices
from scripts.catalog import enrich_storefront as localization
from scripts.catalog import fit_difficulty as regression
from scripts.catalog import publish_playable as publisher
from scripts.catalog import refresh_metrics as sample_peaks
from scripts.catalog.database import initialize
from scripts.catalog.import_current import import_catalog
from scripts.legacy import convert_raw_jsonl as converter


class CatalogTests(unittest.TestCase):
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
        self.assertEqual(record["currentCents"], 3400)

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

    def test_preserves_existing_screenshot_and_release_date(self):
        catalog = {"games": [{"appId": 10, "name": "Game", "type": "game", "metrics": {}, "tags": []}]}
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
        self.assertEqual(result[10]["currentCents"], 3400)
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
