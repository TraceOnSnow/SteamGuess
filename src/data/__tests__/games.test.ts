import { describe, expect, it } from 'vitest';
import type { Game } from '../../types/game';
import { getRandomGame, loadGames, searchGames } from '../games';

function game(appId: number, name: string): Game {
  return {
    appId,
    name,
    releaseDate: '2020-01-01',
    price: { us: { regular: 0 } },
    popularity: { ccu: 0 },
    reviews: { total: 1, positive: 1, negative: 0 },
    tags: { userTags: [], developers: [], publishers: [] },
    difficulty: { score: 25, level: 'normal', source: 'manual' },
  };
}

const games = [
  game(1, 'Half-Life 2'),
  game(2, 'Half-Life'),
  game(3, 'A Half-Life Mod'),
  game(4, 'Portal 2'),
];

describe('game catalog helpers', () => {
  it('prioritizes prefix matches and excludes previous guesses', () => {
    const results = searchGames(games, 'half', new Set([2]));
    expect(results.map(item => item.appId)).toEqual([1, 3]);
  });

  it('searches optional Chinese aliases without changing the difficulty pool', () => {
    const localized = { ...game(5, 'ELDEN RING'), localizedNames: { zh: '艾尔登法环' } };
    expect(searchGames([...games, localized], '艾尔登', new Set()).map(item => item.appId)).toEqual([5]);
  });


  it('keeps searchable catalog rows without difficulty', async () => {
    const valid = game(6, 'Valid');
    const invalid = { ...game(7, 'Invalid'), difficulty: undefined };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ 6: valid, 7: invalid }), { status: 200 });
    try {
      await expect(loadGames()).resolves.toEqual([valid, invalid]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('caps search results', () => {
    expect(searchGames(games, 'a', new Set(), 1)).toHaveLength(1);
  });

  it('avoids the previous answer when alternatives exist', () => {
    const onlyAlternative = [game(1, 'One'), game(2, 'Two')];
    for (let index = 0; index < 20; index += 1) {
      expect(getRandomGame(onlyAlternative, 1).appId).toBe(2);
    }
  });
});
