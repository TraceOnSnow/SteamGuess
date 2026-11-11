import json
import tempfile
import unittest
from pathlib import Path

from scripts.catalog.build_snapshot import clean_game, edition_key, iso_date, searchable, select_answers, store_price, supplement_games
from scripts.catalog.fetch_gaps import extract_storefront_details

EDITION = {"answerLimit": 6, "levels": ["beginner", "easy", "unrated"], "rankCaps": {"beginner": 1, "easy": 3, "unrated": 6}}
EMPTY = {"us": {}, "cn": {}, "spy": {}}


def old(appid, reviews, **extra):
    return {"appId": appid, "name": f"Game {appid}", "type": "game", "releaseDate": "2020 年 1 月 2 日",
            "price": {"us": {"regular": 9.99}, "cn": {"regular": 42.0}},
            "reviews": {"total": reviews, "positive": reviews, "negative": 0}, "popularity": {"ccu": 10},
            "tags": {"userTags": ["Action"], "developers": ["Dev"], "publishers": ["Pub"]},
            "hints": {"screenshotUrls": ["https://example.test/a.jpg"]}, **extra}


class DateTests(unittest.TestCase):
    def test_storefront_formats_become_iso(self):
        cases = {"2016 年 2 月 26 日": "2016-02-26", "2020 年 12 月": "2020-12-01", "Nov 8, 2021": "2021-11-08",
                 "8 Nov, 2021": "2021-11-08", "Nov 2021": "2021-11-01", "2019": "2019-01-01", "2011-04-18": "2011-04-18"}
        for raw, expected in cases.items():
            self.assertEqual(iso_date(raw), expected, raw)

    def test_unknown_dates_are_empty(self):
        for raw in ["", None, "Coming soon", "Q2 2027", "Feb 30, 2021", "To be announced"]:
            self.assertEqual(iso_date(raw), "", raw)


class StoreTests(unittest.TestCase):
    def test_regular_price_ignores_discounts(self):
        payload = {"5": {"success": True, "data": {"name": "Five", "type": "game", "is_free": False,
                                                     "price_overview": {"currency": "USD", "initial": 1999, "final": 499, "discount_percent": 75},
                                                     "release_date": {"date": "Nov 8, 2021"},
                                                     "screenshots": [{"id": 0, "path_full": "https://example.test/full.jpg"}]}}}
        details = extract_storefront_details(payload, 5)
        self.assertEqual(store_price(details), 19.99)
        self.assertEqual(details["screenshots"][0]["path"], "https://example.test/full.jpg")

    def test_free_delisted_and_missing(self):
        self.assertEqual(store_price({"isFree": True, "price": None}), 0.0)
        self.assertIsNone(store_price({"isFree": False, "price": None}))
        self.assertIsNone(extract_storefront_details({"5": {"success": False}}, 5))


class CleanTests(unittest.TestCase):
    def test_fetched_data_fills_gaps_without_losing_curated_fields(self):
        state = {"us": {"7": {"name": "Seven", "type": "game", "isFree": False, "releaseDate": "Mar 3, 2019",
                              "price": {"initialCents": 2999}, "developers": ["Studio"], "publishers": ["Label"],
                              "screenshots": [{"path": f"https://example.test/{index}.jpg"} for index in range(9)], "headerImage": "https://example.test/h.jpg"}},
                 "cn": {"7": {"name": "七", "isFree": False, "price": {"initialCents": 11800}}}, "spy": {"7": ["RPG", "Indie"]}}
        game = clean_game({"appId": 7, "name": "seven", "aliases": ["7", "Seven"], "price": {"us": {"regular": 0.0}, "cn": {}},
                           "reviews": {"total": 5, "positive": 4, "negative": 1}, "popularity": {"ccu": 3}, "tags": {"userTags": []}}, state)
        self.assertEqual(game["name"], "Seven")
        self.assertEqual(game["localizedNames"], {"zh": "七"})
        self.assertEqual(game["aliases"], ["7"])
        self.assertEqual(game["releaseDate"], "2019-03-03")
        self.assertEqual(game["price"], {"us": {"regular": 29.99}, "cn": {"regular": 118.0}})
        self.assertEqual(game["tags"], {"userTags": ["RPG", "Indie"], "developers": ["Studio"], "publishers": ["Label"]})
        self.assertEqual(len(game["_screenshots"]), 6)
        self.assertTrue(searchable(game))

    def test_a_game_the_store_no_longer_lists_loses_its_usd_price_but_stays_searchable(self):
        game = clean_game(old(8, 100), {"us": {"8": None}, "cn": {}, "spy": {}})
        self.assertIsNone(game["price"]["us"]["regular"])
        self.assertEqual(game["price"]["cn"]["regular"], 42.0)
        self.assertEqual(game["releaseDate"], "2020-01-02")
        self.assertTrue(searchable(game))

    def test_incomplete_rows_are_not_searchable(self):
        self.assertFalse(searchable(clean_game(old(9, 100, releaseDate=""), EMPTY)))
        self.assertFalse(searchable(clean_game(old(9, 100, type="dlc"), EMPTY)))
        self.assertFalse(searchable(clean_game(old(9, 100, tags={"userTags": []}), EMPTY)))


class SelectionTests(unittest.TestCase):
    def games(self):
        rows = [old(index, reviews) for index, reviews in enumerate([900, 800, 700, 600, 500, 400, 300, 200], 1)]
        rows[4]["hints"] = {"screenshotUrls": []}  # appId 5 cannot be an answer
        rows[6]["name"] = "Game 2 Definitive Edition"  # appId 7 duplicates appId 2
        return [clean_game(row, EMPTY) for row in rows]

    def test_tiers_follow_heat_and_skip_ineligible_or_duplicate_games(self):
        answers = select_answers(self.games(), EDITION, {})
        self.assertEqual([(entry["appId"], entry["level"]) for entry in answers],
                         [(1, "beginner"), (2, "easy"), (3, "easy"), (4, "unrated"), (6, "unrated"), (8, "unrated")])
        self.assertEqual([entry["rank"] for entry in answers], [1, 2, 3, 4, 5, 6])

    def test_overrides_move_games_while_tier_sizes_stay_fixed(self):
        answers = select_answers(self.games(), EDITION, {"exclude": [1], "level": {"6": "beginner"}})
        levels = {entry["appId"]: entry["level"] for entry in answers}
        self.assertNotIn(1, levels)
        self.assertEqual(levels[6], "beginner")
        self.assertEqual(levels[2], "easy")
        self.assertEqual(sorted(levels.values()).count("easy"), 2)
        self.assertEqual(len(answers), 5)

    def test_edition_keys_merge_re_releases(self):
        self.assertEqual(edition_key("The Witcher® 3: Wild Hunt - Game of the Year Edition"), edition_key("The Witcher 3: Wild Hunt"))
        self.assertNotEqual(edition_key("Portal"), edition_key("Portal 2"))


class SupplementTests(unittest.TestCase):
    def test_store_page_numbers_stand_in_when_steamspy_has_none(self):
        state = {"us": {}, "cn": {}, "spy": {}}
        entries = {
            "50": {"spy": {"name": "Fifty", "positive": 0, "negative": 0, "ccu": 0, "tags": []}, "us": {"name": "Fifty", "developers": ["D"], "publishers": ["P"]},
                   "cn": None, "page": {"tags": ["MOBA"], "reviews": 20000, "positivePercent": 80}, "players": 1234},
            "51": {"spy": {"name": "Small", "positive": 10, "negative": 1, "ccu": 5, "tags": ["Indie"]}, "us": {"name": "Small"}},
            "52": {"spy": {"name": "Known", "positive": 99999, "negative": 1, "ccu": 5, "tags": ["Indie"]}, "us": {"name": "Known"}},
            "53": {"spy": {"name": "No store", "positive": 99999, "negative": 1, "ccu": 5, "tags": ["Indie"]}, "us": None},
        }
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "supplement.json"
            path.write_text(json.dumps(entries), encoding="utf-8")
            rows = supplement_games(path, {52}, state, 10000)
        self.assertEqual([row["appId"] for row in rows], [50])
        self.assertEqual(rows[0]["reviews"], {"total": 20000, "positive": 16000, "negative": 4000})
        self.assertEqual(rows[0]["popularity"], {"ccu": 1234})
        self.assertEqual(rows[0]["tags"]["userTags"], ["MOBA"])
        self.assertIn("50", state["us"])


if __name__ == "__main__":
    unittest.main()
