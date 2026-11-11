import { describe, expect, it } from 'vitest';
import type { Game } from '../types/game';
import { getRandomGame, searchGames } from './games';

export function game(appId: number, name: string, extra: Partial<Game> = {}): Game {
  return {
    appId, name, releaseDate: '2020-01-01',
    price: { us: { regular: 10 }, cn: { regular: 50 } },
    popularity: { ccu: 100 },
    reviews: { total: 100, positive: 90, negative: 10 },
    tags: { userTags: [], developers: [], publishers: [] },
    ...extra,
  };
}

const games = [
  game(1, 'Half-Life 2', { reviews: { total: 900, positive: 880, negative: 20 } }),
  game(2, 'Half-Life'),
  game(3, 'A Half-Life Mod'),
  game(4, 'Portal 2'),
  game(5, 'ELDEN RING', { localizedNames: { zh: '艾尔登法环' }, aliases: ['老头环'] }),
];

describe('searchGames', () => {
  it('ranks exact, then prefix, then better-known matches and skips guessed games', () => {
    expect(searchGames(games, 'half-life', new Set()).map(item => item.appId)).toEqual([2, 1, 3]);
    expect(searchGames(games, 'half', new Set([2])).map(item => item.appId)).toEqual([1, 3]);
  });
  it('ignores case, spaces and punctuation', () => {
    expect(searchGames(games, 'halflife2', new Set())[0].appId).toBe(1);
    expect(searchGames(games, 'elden  ring', new Set())[0].appId).toBe(5);
  });
  it('finds Chinese names and aliases', () => {
    expect(searchGames(games, '艾尔登', new Set())[0].appId).toBe(5);
    expect(searchGames(games, '老头环', new Set())[0].appId).toBe(5);
  });
  it('caps results and returns nothing for an empty query', () => {
    expect(searchGames(games, 'a', new Set(), 1)).toHaveLength(1);
    expect(searchGames(games, '  ', new Set())).toEqual([]);
  });
});

describe('getRandomGame', () => {
  it('avoids the previous answer when alternatives exist', () => {
    const two = [game(1, 'One'), game(2, 'Two')];
    for (let index = 0; index < 20; index += 1) expect(getRandomGame(two, 1).appId).toBe(2);
    expect(getRandomGame([two[0]], 1).appId).toBe(1);
  });
});
