import { describe, expect, it } from 'vitest';
import { ComparisonEngine } from '../ComparisonEngine';
import type { Game } from '../../types/game';

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    appId: 10,
    name: 'Shared Name',
    releaseDate: '2020-01-01',
    price: { us: { currency: 'USD', regular: 20 } },
    popularity: { ccu: 1_000 },
    reviews: { total: 100, positive: 80, negative: 20 },
    tags: { userTags: ['Action'], developers: ['Studio'], publishers: ['Publisher'] },
    ...overrides,
  };
}

describe('ComparisonEngine', () => {
  const engine = new ComparisonEngine();

  it('uses appId rather than a duplicate name for the win condition', () => {
    const result = engine.compare(makeGame({ appId: 11 }), makeGame({ appId: 10 }));
    expect(result.nameMatch.status).toBe('wrong');
    expect(result.isCorrect).toBe(false);
  });

  it('marks every field exact for the answer itself', () => {
    const game = makeGame();
    const result = engine.compare(game, game);

    expect(result.isCorrect).toBe(true);
    expect(result.allFieldsMatches).toHaveLength(6);
    expect(result.allFieldsMatches.every(field => field.status === 'exact')).toBe(true);
  });

  it('includes total reviews in allFieldsMatches', () => {
    const result = engine.compare(makeGame({ reviews: { total: 50, positive: 30, negative: 20 } }), makeGame());
    expect(result.allFieldsMatches).toContain(result.totalReviewsMatch);
  });
});
