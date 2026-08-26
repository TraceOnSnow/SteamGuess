import { describe, expect, it } from 'vitest';
import { isLevelInPool, levelForScore } from './pools';

describe('difficulty pools', () => {
  it('uses cumulative tiers', () => {
    expect(isLevelInPool('easy', 'easy')).toBe(true);
    expect(isLevelInPool('easy', 'hell')).toBe(true);
    expect(isLevelInPool('hell', 'normal')).toBe(false);
  });

  it('maps the public 0-100 score boundaries', () => {
    expect(levelForScore(24)).toBe('easy');
    expect(levelForScore(25)).toBe('normal');
    expect(levelForScore(50)).toBe('hard');
    expect(levelForScore(75)).toBe('hell');
  });
});
