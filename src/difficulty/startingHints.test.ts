import { describe, expect, it } from 'vitest';
import type { Game } from '../types/game';
import {
  DEFAULT_STARTING_HINTS,
  pickRandomHint,
  resolveStartingHintMode,
} from './startingHints';

function game(hints: Game['hints']): Game {
  return { hints } as Game;
}

describe('starting hints', () => {
  it('uses the configured beginner screenshot and easy review', () => {
    const source = game({
      screenshotUrls: ['screenshot'],
      reviewTexts: ['review'],
    });
    expect(resolveStartingHintMode(source, 'beginner', DEFAULT_STARTING_HINTS)).toBe('screenshot');
    expect(resolveStartingHintMode(source, 'easy', DEFAULT_STARTING_HINTS)).toBe('review');
  });

  it('falls back to the other available material', () => {
    expect(resolveStartingHintMode(
      game({ reviewTexts: ['review'] }),
      'beginner',
      DEFAULT_STARTING_HINTS,
    )).toBe('review');
    expect(resolveStartingHintMode(
      game({ screenshotUrls: ['screenshot'] }),
      'easy',
      DEFAULT_STARTING_HINTS,
    )).toBe('screenshot');
  });

  it('returns none when material is missing, disabled, or outside opening tiers', () => {
    const source = game({ screenshotUrls: ['screenshot'], reviewTexts: ['review'] });
    expect(resolveStartingHintMode(game({}), 'beginner', DEFAULT_STARTING_HINTS)).toBe('none');
    expect(resolveStartingHintMode(source, 'beginner', {
      ...DEFAULT_STARTING_HINTS,
      beginner: 'none',
    })).toBe('none');
    for (const level of ['normal', 'hard', 'hell'] as const) {
      expect(resolveStartingHintMode(source, level, DEFAULT_STARTING_HINTS)).toBe('none');
    }
  });

  it('selects one deterministic value for a supplied random source', () => {
    expect(pickRandomHint(['first', 'second', 'third'], () => 0)).toBe('first');
    expect(pickRandomHint(['first', 'second', 'third'], () => 0.99)).toBe('third');
    expect(pickRandomHint([], () => 0.5)).toBeUndefined();
  });
});
