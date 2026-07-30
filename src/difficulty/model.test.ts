import { describe, expect, it } from 'vitest';
import { isLevelInPool, trainDifficultyModel } from './model';
import type { DifficultyLabel, DifficultyLevel, LabelingGame } from '../labeler/types';

function game(appId: number, value: number): LabelingGame {
  return {
    appId,
    name: `Game ${appId}`,
    developers: [],
    publishers: [],
    userTags: [],
    metrics: {
      ccu: value,
      ownersMin: value,
      ownersMax: value,
      positive: value,
      negative: 0,
      reviewsTotal: value,
      averageForeverMinutes: value,
      averageTwoWeeksMinutes: 0,
    },
    recognitionScore: 100 - value,
    recognitionFeatures: {
      owners: value / 100,
      ccu: value / 100,
      reviews: value / 100,
      playtime: value / 100,
      positiveRatio: value / 100,
    },
    suggestedLevel: 'normal',
  };
}

function label(appId: number, level: DifficultyLevel): DifficultyLabel {
  return { appId, level, excluded: false, reviewedAt: '2026-07-29T00:00:00Z' };
}

describe('local difficulty regression', () => {
  it('trains from browser labels and preserves manual decisions', () => {
    const games = Array.from({ length: 24 }, (_, index) => game(index + 1, index * 4));
    const labels = new Map(games.map((item, index) => [
      item.appId,
      label(item.appId, index < 6 ? 'hell' : index < 12 ? 'hard' : index < 18 ? 'normal' : 'easy'),
    ]));
    const model = trainDifficultyModel(games, labels);
    expect(model?.trainingLabels).toBe(24);
    expect(model?.predictions['1'].source).toBe('manual');
    expect(model?.predictions['1'].level).toBe('hell');
  });

  it('uses a manual continuous score as the regression target and prediction', () => {
    const games = Array.from({ length: 24 }, (_, index) => game(index + 1, index * 4));
    const labels = new Map(games.map(item => [item.appId, { ...label(item.appId, 'normal'), score: 42 }]));
    const model = trainDifficultyModel(games, labels);
    expect(model?.predictions['1'].score).toBe(42);
    expect(model?.predictions['1'].source).toBe('manual');
  });

  it('uses nested difficulty pools', () => {
    expect(isLevelInPool('easy', 'easy')).toBe(true);
    expect(isLevelInPool('easy', 'hell')).toBe(true);
    expect(isLevelInPool('hell', 'normal')).toBe(false);
  });
});
