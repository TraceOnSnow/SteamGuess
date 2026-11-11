import { LEVELS } from '../../shared/game-rules.js';
import type { Level } from './rules';

export type Phase = 'playing' | 'won' | 'lost' | 'surrendered';
export type HintState = 'hidden' | 'blurred' | 'clear';
export interface SavedRound {
  answerAppId: number; guesses: number[]; phase: Phase; level: Level;
  session: { id: string; startedAt: string }; hint: HintState; verdict?: 'fair' | 'obscure';
}
export interface Stats { played: number; won: number; best: number | null; streak: number; completedIds: string[] }
export const EMPTY_STATS: Stats = { played: 0, won: 0, best: null, streak: 0, completedIds: [] };

const STATS_KEY = 'steamguess-classics-stats-v1';
// Bump the version when the answer list changes so stale rounds are not resumed.
// `pool` is a tier name or `preset:<id>`, so every pool keeps its own round.
export function roundKey(day: string | undefined, pool: string) { return `steamguess-round-v4:${day ? `daily:${day}` : `practice:${pool}`}`; }

export function readSavedRound(key: string): SavedRound | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    if (!value || !Number.isInteger(value.answerAppId) || !Array.isArray(value.guesses)
      || !value.guesses.every(Number.isInteger) || new Set(value.guesses).size !== value.guesses.length
      || !['playing', 'won', 'lost', 'surrendered'].includes(value.phase) || !LEVELS.includes(value.level)
      || !['hidden', 'blurred', 'clear'].includes(value.hint)
      || typeof value.session?.id !== 'string' || typeof value.session?.startedAt !== 'string') return null;
    return value;
  } catch { return null; }
}
export function saveRound(key: string, round: SavedRound) {
  try { localStorage.setItem(key, JSON.stringify(round)); } catch { /* Playing still works without storage. */ }
}
export function readStats(): Stats {
  try {
    const value = JSON.parse(localStorage.getItem(STATS_KEY) || 'null');
    return value && Number.isInteger(value.played) && Number.isInteger(value.won) && Array.isArray(value.completedIds)
      ? { ...EMPTY_STATS, ...value } : EMPTY_STATS;
  } catch { return EMPTY_STATS; }
}
export function recordResult(id: string, phase: Phase, guesses: number): Stats {
  const old = readStats();
  if (phase === 'playing' || old.completedIds.includes(id)) return old;
  const won = phase === 'won';
  const stats: Stats = {
    played: old.played + 1, won: old.won + Number(won),
    best: won ? Math.min(old.best ?? guesses, guesses) : old.best,
    streak: won ? old.streak + 1 : 0,
    completedIds: [...old.completedIds, id].slice(-500),
  };
  try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch { /* Storage may be full or unavailable. */ }
  return stats;
}
