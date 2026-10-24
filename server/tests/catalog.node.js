import { createMatchEngine } from '../multiplayer/matchEngine.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { difficultyPool, loadCatalog } from '../multiplayer/catalog.js';

function game(appId, score, level) {
  return { appId, name: `Game ${appId}`, difficulty: { score, level } };
}

describe('authoritative multiplayer catalog', () => {
  it('loads the full searchable catalog while answer pools require difficulty', () => {
    const root = mkdtempSync(join(tmpdir(), 'steamguess-catalog-'));
    try {
      mkdirSync(join(root, 'public'));
      writeFileSync(join(root, 'public/games_demo.json'), JSON.stringify({
        1: game(1, 24, 'easy'),
        2: { appId: 2, name: 'Missing difficulty' },
        3: game(3, 101, 'hell'),
        4: game(4, 50, 'hard'),
      }));
      const catalog = loadCatalog(root);
      assert.deepEqual(catalog.map(row => row.appId), [1, 2, 3, 4]);
      assert.deepEqual(difficultyPool(catalog, 'hell').map(row => row.appId), [1, 4]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds cumulative pools exclusively from published levels', () => {
    const catalog = [game(1, 10, 'easy'), game(2, 30, 'normal'), game(3, 60, 'hard'), game(4, 90, 'hell')];
    assert.deepEqual(difficultyPool(catalog, 'normal').map(row => row.appId), [1, 2]);
    assert.deepEqual(difficultyPool(catalog, 'hell').map(row => row.appId), [1, 2, 3, 4]);
  });
});

it('ships five cumulative Classics pools', () => {
  const catalog = loadCatalog(process.cwd());
  assert.equal(catalog.length, 2000);
  const counts = ['beginner', 'easy', 'normal', 'hard', 'hell'].map(level => difficultyPool(catalog, level).length);
  assert.deepEqual(counts, [20, 50, 100, 200, 300]);
});

it('accepts search-only guesses while restricting answers, even if a search row has a stale score', () => {
  const catalog = loadCatalog(process.cwd());
  const outside = catalog.find(game => game.catalogStatus === 'search_only');
  const pool = difficultyPool(catalog, 'beginner');
  const engine = createMatchEngine({ catalog, random: () => 0, onRoundEnd: () => null });
  const room = { pool, settings: { difficulty: 'beginner', roundTimeSeconds: 120 }, players: [{ id: 'test' }] };
  engine.startRound(room);
  assert.ok(pool.some(game => game.appId === room.activeRound.answerAppId));
  const result = engine.guess(room, 'test', outside.appId);
  assert.equal(result.error, undefined);
  assert.equal(result.feedback.isCorrect, false);
  assert.equal(result.guessesUsed, 1);
  assert.deepEqual(difficultyPool([{ ...outside, difficulty: pool[0].difficulty }], 'hell'), []);
  assert.throws(() => engine.startRound({ ...room, pool: [] }), /answer pool is empty/);
});
