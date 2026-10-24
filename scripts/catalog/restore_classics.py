"""Restore the local catalog and publish the deliberately small Classics edition.

No network, historical difficulty model, or new API credentials are required.
A recovered database is preferred; a fresh clone can seed its database from the
committed playable snapshot. Existing databases are backed up before editing.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from scripts.catalog.database import connect, initialize, utc_now
from scripts.catalog.import_current import upsert_game
from scripts.catalog.publish_playable import publish

ROOT = Path(__file__).resolve().parents[2]


def restore(db_path: Path, snapshot_path: Path, curated_path: Path, recovered_path: Path | None = None) -> dict:
    curated = json.loads(curated_path.read_text(encoding='utf-8'))
    snapshot = json.loads(snapshot_path.read_text(encoding='utf-8'))
    snapshots = {int(g['appId']): g for g in (snapshot.values() if isinstance(snapshot, dict) else snapshot)}
    selected = curated['games']
    curated_by_id = {entry['appId']: entry for entry in selected}
    missing = [g['appId'] for g in selected if g['appId'] not in snapshots]
    if missing:
        raise ValueError(f'Curated games missing from snapshot: {missing}')
    db_path.parent.mkdir(parents=True, exist_ok=True)
    if db_path.exists():
        backup = db_path.with_name(f'{db_path.stem}.before-classics-{datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")}.sqlite')
        with sqlite3.connect(db_path) as original, sqlite3.connect(backup) as copy:
            original.backup(copy)
    elif recovered_path and recovered_path.exists():
        with sqlite3.connect(f'file:{recovered_path}?mode=ro', uri=True) as source, sqlite3.connect(db_path) as target:
            source.backup(target)
    connection = connect(db_path)
    initialize(connection)
    now = utc_now()
    with connection:
        # Preserve the richer published metadata and full review snapshots in
        # raw_sources_json; editorial impression clues are not user reviews.
        for appid, g in snapshots.items():
            entry = curated_by_id.get(appid)
            prices = {}
            for cc, price in g.get('price', {}).items():
                if isinstance(price.get('regular'), (int, float)):
                    value = round(price['regular'] * 100)
                    prices[cc] = {'currency': price.get('currency', 'CNY' if cc == 'cn' else 'USD'), 'status': 'free' if value == 0 else 'available', 'regularCents': value}
            metrics = dict(g.get('metrics', {}))
            reviews = g.get('reviews', {})
            for key, value in {'reviewsTotal': reviews.get('total'), 'positive': reviews.get('positive'), 'negative': reviews.get('negative'), **g.get('popularity', {})}.items():
                if value is not None:
                    metrics[key] = value
            tags = g.get('tags', {})
            normalized = {
                'appId': appid, 'name': g['name'], 'type': 'game' if entry else g.get('type'),
                'localizedNames': {'zh': entry['nameZh']} if entry else g.get('localizedNames', {}), 'releaseDate': g['releaseDate'],
                'developers': tags.get('developers', []), 'publishers': tags.get('publishers', []),
                'tags': [{'name': name, 'rank': i + 1} for i, name in enumerate(tags.get('userTags', []))],
                'regionalPrices': prices, 'metrics': metrics,
                'headerImage': g.get('header_image'), 'screenshots': g.get('hints', {}).get('screenshotUrls', []),
                'rawSources': {'recoveredPublishedSnapshot': g},
                'fieldSources': {'curation': 'data/curated/classics.json', 'metadata': 'recovered published snapshot'},
            }
            upsert_game(connection, normalized, g, now)
            if not entry:
                continue
            connection.execute("""UPDATE games SET pool_status='eligible', status_reason=NULL,
                difficulty_score=COALESCE(difficulty_score,20), difficulty_tier=COALESCE(difficulty_tier,'easy'),
                difficulty_manual_score=COALESCE(difficulty_manual_score,20),
                difficulty_source=COALESCE(difficulty_source,'curated-classics-v1') WHERE appid=?""", (entry['appId'],))
            fixed = entry.get('difficulty')
            if fixed:
                connection.execute("""UPDATE games SET difficulty_score=?, difficulty_tier=?,
                    difficulty_source=? WHERE appid=? AND difficulty_locked=0""",
                    (fixed['score'], fixed['level'], fixed['source'], entry['appId']))
        connection.execute("INSERT OR REPLACE INTO catalog_meta VALUES ('edition', 'classics-v1', ?)", (now,))
    assert connection.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    total = connection.execute('SELECT COUNT(*) FROM games').fetchone()[0]
    connection.close()
    selection = db_path.parent / 'classics-selection.json'
    selection.write_text(json.dumps({'collection': 'classics', 'games': selected}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    search_count = publish(selection, db_path, snapshot_path, len(selected))
    return {'databaseRecords': total, 'publishedGames': len(selected), 'searchGames': search_count, 'database': str(db_path), 'snapshot': str(snapshot_path)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, default=ROOT / 'data/catalog/catalog.sqlite')
    parser.add_argument('--snapshot', type=Path, default=ROOT / 'public/games_demo.json')
    parser.add_argument('--curated', type=Path, default=ROOT / 'data/curated/classics.json')
    parser.add_argument('--recovered', type=Path, default=ROOT / 'data/backups/recovery-20261022/converged-catalog.sqlite')
    args = parser.parse_args()
    print(json.dumps(restore(args.db, args.snapshot, args.curated, args.recovered), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
