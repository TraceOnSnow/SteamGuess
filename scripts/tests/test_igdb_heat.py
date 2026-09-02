import unittest

from scripts.catalog.rank_igdb_heat import METRICS, rank_rows


class IgdbHeatTest(unittest.TestCase):
    def test_requested_weights_sum_to_one(self) -> None:
        self.assertAlmostEqual(sum(weight for _, weight in METRICS.values()), 1.0)
        self.assertEqual(METRICS["Playing"][1], 0.3125)
        self.assertEqual(METRICS["Visits"][1], 0.1250)

    def test_rank_rows_uses_requested_weights_for_complete_rows(self) -> None:
        snapshots = {
            name: (
                None,  # type: ignore[arg-type]
                {
                    "popularityType": {"name": name},
                    "rows": [
                        {
                            "igdbGameId": 1,
                            "name": "A",
                            "value": 1.0 if name == "Visits" else 0.0,
                            "rank": 1,
                        },
                        {
                            "igdbGameId": 2,
                            "name": "B",
                            "value": 0.0 if name == "Visits" else 1.0,
                            "rank": 2,
                        },
                    ],
                },
            )
            for name in METRICS
        }
        rows = rank_rows(snapshots, limit=2)
        self.assertEqual(rows[0]["igdbGameId"], 2)
        self.assertEqual(rows[1]["igdbGameId"], 1)
        self.assertEqual(rows[0]["metricCount"], 5)

    def test_missing_both_steam_metrics_are_renormalized_not_zeroed(self) -> None:
        snapshots = {
            name: (
                None,  # type: ignore[arg-type]
                {
                    "popularityType": {"name": name},
                    "rows": (
                        [
                            {
                                "igdbGameId": 1,
                                "name": "Complete",
                                "value": 0.2,
                            }
                        ]
                        if name not in {"24hr Peak Players", "Total Reviews"}
                        else []
                    ),
                },
            )
            for name in METRICS
        }
        rows = rank_rows(snapshots, limit=0)
        row = rows[0]
        self.assertEqual(row["metricCount"], 3)
        self.assertEqual(
            row["missingMetrics"],
            ["steam_total_reviews", "steam_24hr_peak"],
        )
        self.assertEqual(row["steamCoverage"], "not_available")
        self.assertAlmostEqual(row["heatScore"], 0.2)

    def test_non_steam_rows_compete_by_score_with_complete_rows(self) -> None:
        snapshots = {
            name: (
                None,  # type: ignore[arg-type]
                {
                    "popularityType": {"name": name},
                    "rows": (
                        [
                            {
                                "igdbGameId": 1,
                                "name": "Complete but lower score",
                                "value": 0.1,
                                "rank": 1,
                            },
                            {
                                "igdbGameId": 2,
                                "name": "Incomplete but higher score",
                                "value": 1.0,
                                "rank": 2,
                            },
                        ]
                        if name not in {"24hr Peak Players", "Total Reviews"}
                        else [
                            {
                                "igdbGameId": 1,
                                "name": "Complete but lower score",
                                "value": 0.1,
                                "rank": 1,
                            }
                        ]
                    ),
                },
            )
            for name in METRICS
        }

        rows = rank_rows(snapshots, limit=2)

        self.assertEqual(rows[0]["igdbGameId"], 2)
        self.assertEqual(rows[0]["metricCount"], 3)
        self.assertEqual(rows[1]["igdbGameId"], 1)
        self.assertEqual(rows[1]["metricCount"], 5)

    def test_rows_missing_any_igdb_metric_are_discarded(self) -> None:
        snapshots = {
            name: (
                None,  # type: ignore[arg-type]
                {
                    "popularityType": {"name": name},
                    "rows": (
                        []
                        if name == "Visits"
                        else [{"igdbGameId": 1, "name": "Missing visits", "value": 1}]
                    ),
                },
            )
            for name in METRICS
        }

        self.assertEqual(rank_rows(snapshots, limit=0), [])

    def test_rows_missing_only_one_steam_metric_are_discarded(self) -> None:
        snapshots = {
            name: (
                None,  # type: ignore[arg-type]
                {
                    "popularityType": {"name": name},
                    "rows": (
                        []
                        if name == "24hr Peak Players"
                        else [{"igdbGameId": 1, "name": "Partial Steam", "value": 1}]
                    ),
                },
            )
            for name in METRICS
        }

        self.assertEqual(rank_rows(snapshots, limit=0), [])


if __name__ == "__main__":
    unittest.main()
