import { describe, expect, it } from 'vitest';
import { ComparisonEngine } from '../ComparisonEngine';
import type { Game } from '../../types/game';

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    appId: 10,
    name: 'Shared Name',
    releaseDate: '2020-01-01',
    price: { us: { currency: 'USD', regular: 20 }, cn: { currency: 'CNY', regular: 68 } },
    popularity: { ccu: 1_000 },
    reviews: { total: 100, positive: 80, negative: 20 },
    tags: { userTags: ['Action'], developers: ['Studio'], publishers: ['Publisher'] },
    difficulty: { score: 25, level: 'normal', source: 'manual' },
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

  it('uses the mainland-China regular price', () => {
    const guess = makeGame({ price: { us: { regular: 1 }, cn: { currency: 'CNY', regular: 68 } } });
    const answer = makeGame({ price: { us: { regular: 999 }, cn: { currency: 'CNY', regular: 68 } } });
    const result = engine.compare(guess, answer);
    expect(result.priceMatch.status).toBe('exact');
    expect(result.priceMatch.userValue).toContain('68');
  });

  it('marks a missing mainland-China price as unknown instead of converting USD', () => {
    const result = engine.compare(
      makeGame({ price: { us: { regular: 20 }, cn: {} } }),
      makeGame(),
    );
    expect(result.priceMatch.status).toBe('unknown');
    expect(result.priceMatch.userValue).toBeNull();
  });

  it('includes total reviews in allFieldsMatches', () => {
    const result = engine.compare(makeGame({ reviews: { total: 50, positive: 30, negative: 20 } }), makeGame());
    expect(result.allFieldsMatches).toContain(result.totalReviewsMatch);
  });
});
