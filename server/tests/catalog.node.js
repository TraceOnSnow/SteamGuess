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
