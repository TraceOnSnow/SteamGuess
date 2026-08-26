#!/usr/bin/env python3
from __future__ import annotations
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
source = json.loads((ROOT / 'input.json').read_text())
output = json.loads((ROOT / 'luna-candidates.json').read_text())
expected = {int(game['appId']) for game in source['games']}
rows = output.get('evaluations', [])
assert len(rows) == len(expected) == 100, (len(rows), len(expected))
actual = [int(row['appId']) for row in rows]
assert len(set(actual)) == len(actual), 'duplicate AppIDs'
assert set(actual) == expected, f'missing={sorted(expected-set(actual))} extra={sorted(set(actual)-expected)}'
valid_reasons = {None, 'software', 'tool', 'benchmark', 'server', 'demo', 'soundtrack', 'dlc', 'duplicate', 'test-content', 'not-a-reasonable-guess'}
valid_priorities = {'high', 'normal', 'low'}
def level(score: int) -> str:
    return 'easy' if score < 25 else 'normal' if score < 50 else 'hard' if score < 75 else 'hell'
for row in rows:
    score = row.get('score')
    assert isinstance(score, int) and not isinstance(score, bool) and 0 <= score <= 100, row
    assert row.get('level') == level(score), row
    confidence = row.get('confidence')
    assert isinstance(confidence, (int, float)) and not isinstance(confidence, bool) and 0 <= confidence <= 1, row
    assert isinstance(row.get('eligible'), bool), row
    assert row.get('exclusionReason') in valid_reasons, row
    assert row.get('reviewPriority') in valid_priorities, row
    assert isinstance(row.get('reason'), str) and row['reason'].strip(), row
print(f'PASS evaluations={len(rows)} eligible={sum(r["eligible"] for r in rows)} excluded={sum(not r["eligible"] for r in rows)}')
