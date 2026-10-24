import type { Challenge } from './rules';
export type Phase = 'playing' | 'won' | 'lost' | 'surrendered';
export interface SavedRound {
  answerAppId: number; guesses: number[]; phase: Phase; difficulty: Challenge;
  session: { id: string; startedAt: string }; screenshotOpen: boolean; screenshotClear: boolean; screenshotUsed: boolean;
}
export interface Stats { played: number; won: number; best: number | null; completedIds: string[] }
export const EMPTY_STATS: Stats = { played: 0, won: 0, best: null, completedIds: [] };
// A new edition starts new rounds while retaining lifetime statistics.
export function roundKey(day?: string, difficulty: Challenge = 'normal') { return `steamguess-classics-v3:${day || 'practice'}:${difficulty}`; }
export function readSavedRound(key: string): SavedRound | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    if (!value || !Number.isInteger(value.answerAppId) || !Array.isArray(value.guesses)
      || !value.guesses.every(Number.isInteger) || new Set(value.guesses).size !== value.guesses.length
      || !['playing', 'won', 'lost', 'surrendered'].includes(value.phase)
      || !['beginner', 'easy', 'normal', 'hard', 'hell'].includes(value.difficulty)
      || typeof value.session?.id !== 'string' || typeof value.session?.startedAt !== 'string') return null;
    return { ...value, screenshotOpen: Boolean(value.screenshotOpen), screenshotClear: Boolean(value.screenshotClear), screenshotUsed: Boolean(value.screenshotUsed) };
  } catch { return null; }
}
export function readStats(): Stats {
  try { const value = JSON.parse(localStorage.getItem('steamguess-classics-stats-v1') || 'null');
    return value && Number.isInteger(value.played) && Number.isInteger(value.won) && Array.isArray(value.completedIds) ? value : EMPTY_STATS;
  } catch { return EMPTY_STATS; }
}
export function recordResult(id: string, phase: Phase, guesses: number): Stats {
  const old = readStats();
  if (phase === 'playing' || old.completedIds.includes(id)) return old;
  const stats: Stats = { played: old.played + 1, won: old.won + Number(phase === 'won'),
    best: phase === 'won' ? Math.min(old.best ?? guesses, guesses) : old.best,
    completedIds: [...old.completedIds, id].slice(-500) };
  try { localStorage.setItem('steamguess-classics-stats-v1', JSON.stringify(stats)); } catch { /* Storage may be full or unavailable. */ }
  return stats;
}
export function saveRound(key: string, round: SavedRound) {
  try { localStorage.setItem(key, JSON.stringify(round)); } catch { /* Playing still works without storage. */ }
}
