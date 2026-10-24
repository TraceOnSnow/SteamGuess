import type { Game } from '../types/game';
import type { DifficultyLevel } from '../difficulty/types';
import { isLevelInPool } from '../difficulty/pools';
import edition from '../../shared/edition.json';

export type Challenge = DifficultyLevel;
export const CHALLENGES = Object.fromEntries(
  [['beginner', '入门'], ['easy', '简单'], ['normal', '普通'], ['hard', '困难'], ['hell', '地狱']].map(([level, label]) => [level, {
    label, attempts: edition.attempts, poolSize: edition.poolCaps[level as Challenge],
  }]),
) as Record<Challenge, { label: string; attempts: number; poolSize: number }>;
export function normalizeChallenge(value: DifficultyLevel | string | null): Challenge {
  return value && Object.hasOwn(CHALLENGES, value) ? value as Challenge : 'normal';
}
export function dateKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function dailyGame(games: Game[], day: string): Game {
  if (!games.length) throw new Error('The answer pool is empty.');
  const ordered = [...games].sort((a, b) => a.appId - b.appId);
  const days = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86400000);
  return ordered[((days % ordered.length) + ordered.length) % ordered.length];
}
export function eligibleAnswers(games: Game[], difficulty: Challenge = 'hell'): Game[] {
  return games.filter(game => game.catalogStatus !== 'search_only' && game.catalogStatus !== 'excluded'
    && Boolean(game.difficulty) && isLevelInPool(game.difficulty!.level, difficulty));
}
