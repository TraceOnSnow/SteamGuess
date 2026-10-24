"""Select a fixed 300-game answer catalog from recovered Steam metadata."""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from scripts.catalog.freeze_difficulty import freeze
from scripts.catalog.rank_steamspy import rank_rows

ROOT = Path(__file__).resolve().parents[2]


def edition_key(name):
    value = name.casefold().replace('™', '').replace('®', '')
    value = re.sub(r'\b(game of the year|goty|special|enhanced|definitive|ultimate|anniversary|remastered|remaster)( edition)?\b', '', value)
    return re.sub(r'[^\w]', '', value)


def select(db_path, curated_path, snapshot_path, backup_dir):
    policy = json.loads((ROOT / 'shared/edition.json').read_text())
    old = json.loads(curated_path.read_text())
    old_by_id = {entry['appId']: entry for entry in old['games']}
    with sqlite3.connect(f'file:{db_path}?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        games = {row['appid']: row for row in db.execute("""
            SELECT appid,name_en,name_zh,app_type,pool_status,release_date,tags_json,
                   screenshot_urls_json,steam_reviews_total,steam_ccu
            FROM games
        """)}
    ranked = rank_rows([{'appId': row['appid'], 'commentCount': max(0,row['steam_reviews_total'] or 0), 'ccu': max(0,row['steam_ccu'] or 0), 'page': 0}
                        for row in games.values() if row['steam_reviews_total'] is not None])
    selected = []
    seen = set()
    skipped = []
    for metric in ranked:
        game = games[metric['appId']]
        if game['pool_status'] == 'excluded' or str(game['app_type'] or '').lower() not in {'game', 'mod'}:
            continue
        if not game['release_date'] or not json.loads(game['tags_json']) or not json.loads(game['screenshot_urls_json']):
            continue
        key = edition_key(game['name_en'])
        if key in seen:
            skipped.append({'appId': game['appid'], 'name': game['name_en'], 'reason': 'duplicate_edition'})
            continue
        seen.add(key)
        previous = old_by_id.get(game['appid'], {})
        selected.append({'appId': game['appid'], 'nameZh': previous.get('nameZh') or game['name_zh'] or game['name_en'],
                         'aliases': previous.get('aliases', [])})
        if len(selected) == policy['answerLimit']:
            break
    if len(selected) != policy['answerLimit']:
        raise ValueError('Not enough games with release date, tags and screenshots')
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup = backup_dir / f'classics-before-{datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")}.json'
    backup.write_bytes(curated_path.read_bytes())
    payload = {'version': 2, 'collection': 'classics', 'description': '固定热度分档；截图提示。', 'games': selected,
               'selectionPolicy': {'source': 'recovered-steamspy-weighted', 'require': ['game_type', 'release_date', 'tags', 'screenshots'], 'skipped': skipped}}
    with tempfile.TemporaryDirectory(prefix='classics-selection-', dir=curated_path.parent) as folder:
        candidate = Path(folder) / 'classics.json'
        candidate.write_text(json.dumps(payload, ensure_ascii=False, indent=2)+'\n')
        freeze(candidate, snapshot_path, db_path)
        candidate.replace(curated_path)
    return {'answers': len(selected), 'skippedEditions': len(skipped), 'backup': str(backup)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, default=ROOT/'data/catalog/catalog.sqlite')
    parser.add_argument('--curated', type=Path, default=ROOT/'data/curated/classics.json')
    parser.add_argument('--snapshot', type=Path, default=ROOT/'public/games_demo.json')
    parser.add_argument('--backup-dir', type=Path, default=ROOT/'data/backups')
    args = parser.parse_args()
    print(json.dumps(select(args.db,args.curated,args.snapshot,args.backup_dir),ensure_ascii=False,indent=2))


if __name__ == '__main__':
    main()
