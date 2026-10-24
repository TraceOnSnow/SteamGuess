import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from scripts.catalog.restore_classics import restore


class RestoreClassicsTests(unittest.TestCase):
    def test_fresh_clone_restores_and_republishes_without_backup_or_network(self):
        root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            snapshot = base / 'games.json'
            snapshot.write_bytes((root / 'public/games_demo.json').read_bytes())
            db = base / 'catalog.sqlite'
            result = restore(db, snapshot, root / 'data/curated/classics.json')
            self.assertEqual(result['publishedGames'], 300)
            published = json.loads(snapshot.read_text())
            self.assertTrue(all(g['reviews']['total'] > 0 for g in published.values()))
            self.assertEqual(len(published), 2000)
            self.assertEqual(sum('difficulty' in g for g in published.values()), 300)
            self.assertTrue(all(g['hints']['screenshotUrls'] for g in published.values() if 'difficulty' in g))
            self.assertTrue(all('impression' not in g.get('hints', {}) and 'reviewTexts' not in g.get('hints', {}) for g in published.values()))
            self.assertTrue(all(g.get('collection') == 'classics' for g in published.values() if 'difficulty' in g))
            self.assertTrue(all(g['catalogStatus'] == 'search_only' and 'hints' not in g for g in published.values() if 'difficulty' not in g))
            with sqlite3.connect(db) as connection:
                connection.execute("UPDATE games SET difficulty_score=33, difficulty_tier='normal', difficulty_locked=1 WHERE appid=730")
            restore(db, snapshot, root / 'data/curated/classics.json')
            with sqlite3.connect(db) as connection:
                self.assertEqual(connection.execute('SELECT COUNT(*) FROM games').fetchone()[0], 2000)
                self.assertEqual(connection.execute('SELECT difficulty_score,difficulty_locked FROM games WHERE appid=730').fetchone(), (33, 1))
            self.assertEqual(len(list(base.glob('catalog.before-classics-*.sqlite'))), 1)
