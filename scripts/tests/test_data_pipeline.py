import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


catalog = load("catalog", "scripts/build_steamspy_catalog.py")
regression = load("regression", "scripts/fit_difficulty_regression.py")
converter = load("converter", "scripts/convert_raw_jsonl.py")
localization = load("localization", "scripts/fetch_localized_names.py")


class CatalogTests(unittest.TestCase):
    def test_decode_proxy_payload(self):
        payload = catalog.decode_payload("Title: x\n\nMarkdown Content:\n{\"1\": {\"appid\": 1}}")
        self.assertEqual(payload["1"]["appid"], 1)

    def test_parse_owners(self):
        self.assertEqual(catalog.parse_owners("1,000,000 .. 2,000,000"), (1_000_000, 2_000_000))

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


if __name__ == "__main__":
    unittest.main()
