"""Freeze five cumulative familiarity pools; never regrade at runtime.

Prefer the project's original IGDB heat ranking when explicitly supplied. The
recovered archive has no IGDB primitives: the shipped bootstrap therefore uses
the existing SteamSpy 85% reviews / 15% CCU log-normalized formula, with an
explicit source label. Only the small editorial whitelist is ever eligible.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sqlite3
from pathlib import Path

from scripts.catalog.rank_igdb_heat import METRICS
from scripts.catalog.rank_steamspy import rank_rows

ROOT = Path(__file__).resolve().parents[2]
POLICY = json.loads((ROOT / 'shared/edition.json').read_text())
LEVELS = [(level, cap, score) for (level, cap), score in zip(POLICY['poolCaps'].items(), [7,20,37,62,87])]


def normalized_name(value):
    return re.sub(r'[^\w]', '', str(value).casefold())


def make_ranking(curated, published, db_path, igdb_path=None, mapping=None):
    entries = curated['games']
    if igdb_path:
        payload = json.loads(igdb_path.read_text(encoding='utf-8'))
        weights = {field: weight for field, weight in METRICS.values()}
        if payload.get('formula', {}).get('weights') != weights:
            raise ValueError('IGDB ranking must use the original five-metric formula from rank_igdb_heat.py')
        mapping = mapping or {}
        ids = {entry['appId'] for entry in entries}
        matches = {appid: [] for appid in ids}
        for row in payload['rows']:
            for entry in entries:
                appid = entry['appId']
                mapped_id = mapping.get(str(appid)) or entry.get('igdbGameId')
                exact_name = normalized_name(row.get('name')) == normalized_name(published[str(appid)]['name'])
                if (row.get('appId') == appid or (mapped_id and row.get('igdbGameId') == mapped_id)
                        or (not mapped_id and exact_name)):
                    matches[appid].append(row)
        missing = [appid for appid, rows in matches.items() if len(rows) != 1]
        if missing:
            raise ValueError(f'IGDB mapping must be unique and complete; missing/ambiguous AppIDs: {missing}')
        ranked = []
        for appid, rows in matches.items():
            row = rows[0]
            score = row.get('heatScore')
            if not isinstance(score, (int, float)) or not math.isfinite(score) or score < 0:
                raise ValueError(f'Invalid IGDB heat score for {appid}')
            ranked.append({'appId': appid, 'heatScore': score, 'heatRank': row['rank'], 'igdbGameId': row['igdbGameId']})
        source = 'igdb-popscore-frozen'
        provenance = {'source': source, 'weights': weights, 'inputSha256': hashlib.sha256(igdb_path.read_bytes()).hexdigest()}
    else:
        # Keep the existing formula and normalization population, rather than
        # pretending raw Steam counts are IGDB's dimensionless PopScores.
        with sqlite3.connect(f'file:{db_path}?mode=ro', uri=True) as db:
            rows = [{'appId': appid, 'commentCount': max(0, reviews or 0), 'ccu': max(0, ccu or 0), 'page': 0}
                    for appid, reviews, ccu in db.execute('SELECT appid, steam_reviews_total, steam_ccu FROM games WHERE steam_reviews_total IS NOT NULL')]
        ranked_all = rank_rows(rows)
        wanted = {entry['appId'] for entry in entries}
        ranked = [{'appId': row['appId'], 'heatScore': row['score'], 'heatRank': row['rank'], 'reviews': row['commentCount'], 'ccu': row['ccu']} for row in ranked_all if row['appId'] in wanted]
        if len(ranked) != len(entries):
            raise ValueError('The recovered metrics do not cover the complete curated selection')
        source = 'steamspy-weighted-frozen'
        provenance = {'source': source, 'weights': {'logNormalizedReviewCount': .85, 'logNormalizedCcu': .15}, 'population': len(rows), 'note': 'Recovered Steam snapshot; not IGDB PopScore. No scheduled or feedback-based regrading.'}
    ranked.sort(key=lambda row: (-row['heatScore'], row['appId']))
    return ranked, provenance


def freeze(curated_path, snapshot_path, db_path, igdb_path=None, mapping=None):
    curated = json.loads(curated_path.read_text(encoding='utf-8'))
    published = json.loads(snapshot_path.read_text(encoding='utf-8'))
    ranked, provenance = make_ranking(curated, published, db_path, igdb_path, mapping)
    by_id = {row['appId']: (i, row) for i, row in enumerate(ranked, 1)}
    if len(ranked) != LEVELS[-1][1]:
        raise ValueError('Review the pool caps explicitly when changing the answer selection')
    for entry in curated['games']:
        rank, row = by_id[entry['appId']]
        level, _, score = next(level for level in LEVELS if rank <= level[1])
        entry['difficulty'] = {'level': level, 'score': score, 'source': provenance['source'], 'locked': True}
        entry['familiarity'] = {**row, 'selectionRank': rank}
    curated['description'] = '固定五档题库，十次猜测，截图提示。'
    curated['difficultyPolicy'] = {**provenance, 'mode': 'frozen', 'poolCaps': {level: cap for level, cap, _ in LEVELS}, 'attempts': 10}
    temporary = curated_path.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(curated, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(curated_path)
    return {'source': provenance['source'], 'pools': {level: cap for level, cap, _ in LEVELS}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--curated', type=Path, default=ROOT / 'data/curated/classics.json')
    parser.add_argument('--snapshot', type=Path, default=ROOT / 'public/games_demo.json')
    parser.add_argument('--db', type=Path, default=ROOT / 'data/catalog/catalog.sqlite')
    parser.add_argument('--igdb-ranking', type=Path)
    parser.add_argument('--igdb-mapping', type=Path, help='Optional JSON object mapping Steam AppID to IGDB game ID')
    args = parser.parse_args()
    mapping = json.loads(args.igdb_mapping.read_text()) if args.igdb_mapping else None
    print(json.dumps(freeze(args.curated, args.snapshot, args.db, args.igdb_ranking, mapping), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
