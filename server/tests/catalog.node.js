import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { difficultyPool, loadCatalog } from '../multiplayer/catalog.js';
import { createMatchEngine } from '../multiplayer/matchEngine.js';

const edition = JSON.parse(readFileSync(join(process.cwd(), 'shared/edition.json'), 'utf8'));
const game = (appId, level) => ({ appId, name: `Game ${appId}`, ...(level ? { difficulty: { level } } : {}) });

describe('authoritative multiplayer catalog', () => {
  it('loads every searchable game but only answers enter a pool', () => {
    const root = mkdtempSync(join(tmpdir(), 'steamguess-catalog-'));
    try {
      mkdirSync(join(root, 'public'));
      writeFileSync(join(root, 'public/games_demo.json'), JSON.stringify({ 1: game(1, 'easy'), 2: game(2), 3: game(3, 'legendary'), 4: game(4, 'hard') }));
      const catalog = loadCatalog(root);
      assert.deepEqual(catalog.map(row => row.appId), [1, 2, 3, 4]);
      assert.deepEqual(difficultyPool(catalog, 'hard').map(row => row.appId), [1, 4]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds cumulative pools and keeps the unverified tail out of rooms', () => {
    const catalog = [game(1, 'beginner'), game(2, 'easy'), game(3, 'normal'), game(4, 'hard'), game(5, 'unrated')];
    assert.deepEqual(difficultyPool(catalog, 'beginner').map(row => row.appId), [1]);
    assert.deepEqual(difficultyPool(catalog, 'normal').map(row => row.appId), [1, 2, 3]);
    assert.deepEqual(difficultyPool(catalog, 'hard').map(row => row.appId), [1, 2, 3, 4]);
    assert.deepEqual(difficultyPool(catalog, 'unrated'), []);
  });
});

describe('published snapshot', () => {
  it('ships the rated pools at their configured sizes', () => {
    const catalog = loadCatalog(process.cwd());
    const rated = edition.ratedLevels;
    assert.deepEqual(rated.map(level => difficultyPool(catalog, level).length), rated.map(level => edition.rankCaps[level]));
  });

  it('accepts search-only guesses while only answers can be drawn', () => {
    const catalog = loadCatalog(process.cwd());
    const outside = catalog.find(row => !row.difficulty);
    const pool = difficultyPool(catalog, 'beginner');
    const engine = createMatchEngine({ catalog, random: () => 0, onRoundEnd: () => null });
    const room = { pool, settings: { difficulty: 'beginner', roundTimeSeconds: 120, currency: 'USD' }, players: [{ id: 'test' }] };
    engine.startRound(room);
    assert.ok(pool.some(row => row.appId === room.activeRound.answerAppId));
    const result = engine.guess(room, 'test', outside.appId);
    assert.equal(result.error, undefined);
    assert.equal(result.feedback.isCorrect, false);
    assert.equal(result.guessesUsed, 1);
    assert.throws(() => engine.startRound({ ...room, pool: [] }), /answer pool is empty/);
  });
});
