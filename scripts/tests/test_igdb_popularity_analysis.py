import unittest

from scripts.catalog.analyze_igdb_popularity import jaccard, normalized_name


class IgdbPopularityAnalysisTest(unittest.TestCase):
    def test_normalized_name_ignores_case_width_and_punctuation(self) -> None:
        self.assertEqual(
            normalized_name("PUBG: BATTLEGROUNDS"),
            normalized_name("ＰＵＢＧ Battlegrounds"),
        )

    def test_normalized_name_keeps_meaningful_letters_and_numbers(self) -> None:
        self.assertNotEqual(
            normalized_name("Portal"),
            normalized_name("Portal 2"),
        )

    def test_jaccard(self) -> None:
        self.assertAlmostEqual(jaccard({"a", "b"}, {"b", "c"}), 1 / 3)
        self.assertEqual(jaccard(set(), set()), 1.0)


if __name__ == "__main__":
    unittest.main()
