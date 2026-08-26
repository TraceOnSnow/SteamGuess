import type { DifficultyLevel } from './types';

export const DIFFICULTY_LEVELS: DifficultyLevel[] = ['beginner', 'easy', 'normal', 'hard', 'hell'];
export const DIFFICULTY_SCORE_TARGETS: Record<DifficultyLevel, number> = {
  beginner: 7,
  easy: 20,
  normal: 37,
  hard: 62,
  hell: 87,
};

export function levelForScore(score: number): DifficultyLevel {
  if (score < 15) return 'beginner';
  if (score < 25) return 'easy';
  if (score < 50) return 'normal';
  if (score < 75) return 'hard';
  return 'hell';
}

/** Difficulty pools are cumulative: each tier includes every easier tier. */
export function isLevelInPool(level: DifficultyLevel, pool: DifficultyLevel): boolean {
  return DIFFICULTY_LEVELS.indexOf(level) <= DIFFICULTY_LEVELS.indexOf(pool);
}
