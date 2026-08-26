import type { Game } from '../types/game';
import type { DifficultyLevel, StartingHintMode } from './types';

export type StartingHintPreferences = Pick<
  Record<DifficultyLevel, StartingHintMode>,
  'beginner' | 'easy'
>;

export const DEFAULT_STARTING_HINTS: StartingHintPreferences = {
  beginner: 'screenshot',
  easy: 'review',
};

export function resolveStartingHintMode(
  game: Game | null,
  difficulty: DifficultyLevel,
  preferences: StartingHintPreferences,
): StartingHintMode {
  if (!game || (difficulty !== 'beginner' && difficulty !== 'easy')) return 'none';
  const preferred = preferences[difficulty];
  if (preferred === 'none') return 'none';
  const hasScreenshots = Boolean(game.hints?.screenshotUrls?.length);
  const hasReviews = Boolean(game.hints?.reviewTexts?.some(text => text.trim()));
  if (preferred === 'screenshot') {
    return hasScreenshots ? 'screenshot' : hasReviews ? 'review' : 'none';
  }
  return hasReviews ? 'review' : hasScreenshots ? 'screenshot' : 'none';
}

/** Select once when a round mounts; callers retain the returned value. */
export function pickRandomHint<T>(
  values: readonly T[] | undefined,
  random: () => number = Math.random,
): T | undefined {
  if (!values?.length) return undefined;
  const index = Math.min(values.length - 1, Math.max(0, Math.floor(random() * values.length)));
  return values[index];
}
