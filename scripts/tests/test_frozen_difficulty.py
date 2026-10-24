import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from scripts.catalog.freeze_difficulty import freeze
from scripts.catalog.rank_igdb_heat import METRICS


class FrozenDifficultyTests(unittest.TestCase):
    def fixture(self, root):
        config = json.loads(Path('data/curated/classics.json').read_text())
        snapshot = json.loads(Path('public/games_demo.json').read_text())
        target = root / 'classics.json'
        target.write_text(json.dumps(config))
        games = root / 'games.json'
        games.write_text(json.dumps(snapshot))
        return config, snapshot, target, games

    def test_original_igdb_formula_can_replace_bootstrap_without_steam_substitution(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            config, snapshot, target, games = self.fixture(root)
            rows = [{'appId': game['appId'], 'igdbGameId': i+1, 'name': snapshot[str(game['appId'])]['name'], 'rank': i+1, 'heatScore': 1/(i+1)} for i, game in enumerate(config['games'])]
            ranking = root / 'igdb.json'
            ranking.write_text(json.dumps({'formula': {'weights': {field: weight for field, weight in METRICS.values()}}, 'rows': rows}))
            report = freeze(target, games, root / 'absent.sqlite', ranking)
            self.assertEqual(report['source'], 'igdb-popscore-frozen')
            result = json.loads(target.read_text())
            self.assertTrue(all(game['difficulty']['source'] == 'igdb-popscore-frozen' for game in result['games']))
            self.assertEqual(result['difficultyPolicy']['poolCaps'], {'beginner': 20, 'easy': 50, 'normal': 100, 'hard': 200, 'hell': 300})
            # Missing data must fail before replacing the valid frozen result.
            before = target.read_bytes()
            rows.pop()
            ranking.write_text(json.dumps({'formula': {'weights': {field: weight for field, weight in METRICS.values()}}, 'rows': rows}))
            with self.assertRaisesRegex(ValueError, 'unique and complete'):
                freeze(target, games, root / 'absent.sqlite', ranking)
            self.assertEqual(target.read_bytes(), before)

    def test_bootstrap_is_explicit_and_repeatable(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            config, snapshot, target, games = self.fixture(root)
            db = root / 'metrics.sqlite'
            with sqlite3.connect(db) as conn:
                conn.execute('CREATE TABLE games (appid INTEGER, steam_reviews_total INTEGER, steam_ccu INTEGER)')
                for appid, game in snapshot.items():
                    conn.execute('INSERT INTO games VALUES (?,?,?)', (int(appid), game['reviews']['total'], game['popularity']['ccu']))
            freeze(target, games, db)
            first = target.read_bytes()
            freeze(target, games, db)
            self.assertEqual(target.read_bytes(), first)
            self.assertEqual(json.loads(first)['difficultyPolicy']['source'], 'steamspy-weighted-frozen')
