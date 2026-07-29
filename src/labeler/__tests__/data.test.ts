import { describe, expect, it } from 'vitest';
import { chooseRandomUnlabeled, searchLabelingGames } from '../data';
import type { LabelingGame } from '../types';

function game(appId: number, name: string, recognitionScore = 50): LabelingGame {
  return {
    appId,
    name,
    developers: [],
    publishers: [],
    userTags: [],
    metrics: {
      ccu: 0,
      ownersMin: 0,
      ownersMax: 0,
      positive: 0,
      negative: 0,
      reviewsTotal: 0,
      averageForeverMinutes: 0,
      averageTwoWeeksMinutes: 0,
    },
    recognitionScore,
    suggestedLevel: 'normal',
  };
}

const games = [game(730, 'Counter-Strike 2', 99), game(570, 'Dota 2', 98), game(10, 'Counter-Strike', 95)];

describe('labeler catalog helpers', () => {
  it('searches by app id and prioritizes exact app id', () => {
    expect(searchLabelingGames(games, '570')[0]?.appId).toBe(570);
  });

  it('searches names', () => {
    expect(searchLabelingGames(games, 'counter').map(item => item.appId)).toEqual([730, 10]);
  });

  it('only chooses unlabeled games', () => {
    expect(chooseRandomUnlabeled(games, new Set([730, 570]), undefined, () => 0)?.appId).toBe(10);
  });
});
