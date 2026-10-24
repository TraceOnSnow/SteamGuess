import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from scripts.catalog.select_classics import select


class SelectClassicsTests(unittest.TestCase):
    def test_selects_complete_distinct_editions_and_freezes_five_pools(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            db = root / 'games.sqlite'
            with sqlite3.connect(db) as conn:
                conn.execute('''CREATE TABLE games (appid INTEGER, name_en TEXT, name_zh TEXT,
                    app_type TEXT, pool_status TEXT, release_date TEXT, tags_json TEXT,
                    screenshot_urls_json TEXT, steam_reviews_total INTEGER, steam_ccu INTEGER)''')
                rows = [(i, f'Game {i}', f'游戏 {i}', 'game', 'eligible', '2020-01-01', '["Action"]', '["https://example.com/scene.jpg"]', 10000-i, 1000-i) for i in range(1, 306)]
                # More popular entries must still meet the metadata requirements.
                rows.extend([(400, 'Game 1: Definitive Edition', '', 'game', 'eligible', '2020-01-01', '["Action"]', '["https://example.com/scene.jpg"]', 9999, 999),
                             (401, 'Missing screenshot', '', 'game', 'eligible', '2020-01-01', '["Action"]', '[]', 100000, 10000),
                             (402, 'Excluded', '', 'game', 'excluded', '2020-01-01', '["Action"]', '["scene.jpg"]', 100000, 10000),
                             (403, 'Soundtrack', '', 'dlc', 'eligible', '2020-01-01', '["Action"]', '["scene.jpg"]', 100000, 10000)])
                conn.executemany('INSERT INTO games VALUES (?,?,?,?,?,?,?,?,?,?)', rows)
            target = root / 'classics.json'
            original = {'games': [{'appId': 1, 'nameZh': '原中文名', 'aliases': ['原别名'], 'impression': 'Delete this description'}]}
            target.write_text(json.dumps(original))
            snapshot = root / 'snapshot.json'
            snapshot.write_text('{}')
            select(db, target, snapshot, root / 'backups')
            result = json.loads(target.read_text())
            self.assertEqual([game['appId'] for game in result['games']], list(range(1, 301)))
            self.assertEqual(result['games'][0]['aliases'], ['原别名'])
            self.assertEqual(result['games'][0]['nameZh'], '原中文名')
            self.assertTrue(all('impression' not in game for game in result['games']))
            self.assertEqual(result['difficultyPolicy']['poolCaps'], {'beginner': 20, 'easy': 50, 'normal': 100, 'hard': 200, 'hell': 300})
            self.assertEqual(len(list((root / 'backups').glob('*.json'))), 1)
            first = target.read_bytes()
            select(db, target, snapshot, root / 'backups')
            self.assertEqual(target.read_bytes(), first)
