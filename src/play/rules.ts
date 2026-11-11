import edition from '../../shared/edition.json';
import { LEVELS, RATED_LEVELS, answerPool, dailyGame } from '../../shared/game-rules.js';
import type { Level } from '../../shared/game-rules.js';
import type { Game } from '../types/game';

export type { Level };
export { LEVELS, RATED_LEVELS, answerPool, dailyGame };
export const ATTEMPTS = edition.attempts;
export const DAILY_LEVEL = edition.dailyLevel as Level;
export const POOL_SIZES = edition.rankCaps as Record<Level, number>;

export function normalizeLevel(value: unknown): Level {
  return LEVELS.includes(value as Level) ? value as Level : 'normal';
}

/** Local calendar day; the daily answer changes at the player's midnight. */
export function dateKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function dailyAnswer(games: Game[], day: string): Game {
  return dailyGame(answerPool(games, DAILY_LEVEL), day);
}
