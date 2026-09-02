import { describe, expect, it } from 'vitest';
import type { Game } from '../../types/game';
import { buildMetadataMatchSets, getCompanies, isSharedCompany, orderByMatch } from './metadata';

const game: Game = {
  appId: 1,
  name: 'Example',
  releaseDate: '2020-01-01',
  price: { us: { regular: 20 } },
  popularity: { ccu: 1 },
  reviews: { total: 1, positive: 1, negative: 0 },
  tags: {
    developers: ['Same Company'],
    publishers: ['Other Company'],
    userTags: ['Action'],
  },
  difficulty: { score: 25, level: 'normal', source: 'manual' },
};

describe('GameTable metadata matching', () => {
  it('does not mix developers, publishers, and user tags', () => {
    const sets = buildMetadataMatchSets(game);
    expect(sets.developer.has('same company')).toBe(true);
    expect(sets.publisher.has('same company')).toBe(false);
    expect(sets.user.has('same company')).toBe(false);
  });

  it('moves matching user tags to the front without dropping the others', () => {
    expect(orderByMatch(['Action', 'Puzzle', 'Indie'], new Set(['puzzle']))).toEqual([
      'Puzzle',
      'Action',
      'Indie',
    ]);
  });

  it('shows a self-publishing company once and preserves both roles', () => {
    const selfPublished = {
      ...game,
      tags: { ...game.tags, developers: ['Same Company'], publishers: ['Same Company'] },
    };
    const [company] = getCompanies(selfPublished);
    expect(getCompanies(selfPublished)).toHaveLength(1);
    expect(company.kinds).toEqual(['developer', 'publisher']);
    expect(isSharedCompany(company, buildMetadataMatchSets(selfPublished))).toBe(true);
  });
});
