import { describe, expect, it, afterEach, vi } from 'vitest';
import published from '../../public/games_demo.json?raw';
import { ComparisonEngine } from '../engine/ComparisonEngine';
import { hasDifficulty, loadGames, searchGames } from '../data/games';
import { CHALLENGES, dailyGame, eligibleAnswers, normalizeChallenge } from './rules';
import { EMPTY_STATS, readSavedRound, recordResult, roundKey, saveRound } from './progress';
import type { Game } from '../types/game';

const games: Game[] = Object.values(JSON.parse(published));
afterEach(() => vi.unstubAllGlobals());
describe('Classics release contract', () => {
  it('loads the actual published data through the frontend and compares every answer', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(games)));
    const loaded = await loadGames();
    expect(loaded).toHaveLength(2000);
    const answers = loaded.filter(hasDifficulty);
    expect(answers).toHaveLength(300);
    for (const game of loaded) {
      expect(new ComparisonEngine().compare(game, game).isCorrect).toBe(true);
      if (hasDifficulty(game)) {
        expect(game.localizedNames?.zh).toBeTruthy();
        expect(game.releaseDate).toBeTruthy();
        expect(game.hints).not.toHaveProperty('impression');
        expect(game.hints?.reviewTexts).toBeUndefined();
        expect(game.hints?.screenshotUrls?.length).toBeGreaterThan(0);
      } else {
        expect(game.catalogStatus).toBe('search_only');
        expect(game.hints).toBeUndefined();
      }
    }
    expect(eligibleAnswers(loaded)).toHaveLength(300);
  });
  it('searches and compares outside the answer pool without making those games eligible', () => {
    const outside = games.find(game => game.catalogStatus === 'search_only')!;
    const answer = eligibleAnswers(games, 'beginner')[0];
    expect(searchGames(games, outside.name, new Set(), 20).some(game => game.appId === outside.appId)).toBe(true);
    expect(new ComparisonEngine().compare(outside, answer).isCorrect).toBe(false);
    expect(eligibleAnswers([outside], 'hell')).toHaveLength(0);
    expect(eligibleAnswers([{ ...outside, difficulty: answer.difficulty }], 'hell')).toHaveLength(0);
  });
  it('finds common aliases and never repeats submitted guesses', () => {
    expect(searchGames(games, '老头环', new Set())[0].appId).toBe(1245620);
    expect(searchGames(games, 'GTA5', new Set())[0].appId).toBe(271590);
    expect(searchGames(games, 'GTA5', new Set([271590]))).toHaveLength(0);
  });
  it('offers one stable daily answer across ordering and traverses the pool', () => {
    const answers = eligibleAnswers(games);
    expect(dailyGame(answers, '2026-10-23').appId).toBe(dailyGame([...answers].reverse(), '2026-10-23').appId);
    const ids = new Set(Array.from({ length: 300 }, (_, i) => dailyGame(answers, new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10)).appId));
    expect(ids.size).toBe(300);
  });
  it('uses five nested familiarity pools with the same ten guesses', () => {
    const levels = ['beginner', 'easy', 'normal', 'hard', 'hell'] as const;
    expect(levels.map(level => CHALLENGES[level].attempts)).toEqual([10, 10, 10, 10, 10]);
    expect(levels.map(level => eligibleAnswers(games, level).length)).toEqual([20, 50, 100, 200, 300]);
    let previous = new Set<number>();
    for (const level of levels) {
      const pool = eligibleAnswers(games, level);
      const ids = new Set(pool.map(game => game.appId));
      expect([...previous].every(id => ids.has(id))).toBe(true);
      previous = ids;
    }
    expect(normalizeChallenge('hell')).toBe('hell');
    expect(roundKey('2026-10-23', 'easy')).not.toBe(roundKey('2026-10-23', 'hard'));
  });
});
describe('local progress', () => {
  function storage() { const values = new Map<string, string>(); vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) }); }
  it('restores a round and counts a completed session exactly once', () => {
    storage(); const key = roundKey('2026-10-23');
    const round = { answerAppId: 730, guesses: [440], phase: 'playing' as const, difficulty: 'normal' as const, session: { id: 'session_a', startedAt: '2026-10-23' }, screenshotOpen: true, screenshotClear: true, screenshotUsed: true };
    saveRound(key, round); expect(readSavedRound(key)).toEqual(round);
    expect(recordResult('session_a', 'won', 3).played).toBe(1);
    expect(recordResult('session_a', 'won', 3).played).toBe(1);
    expect(recordResult('session_b', 'lost', 8).won).toBe(1);
  });
  it('survives unavailable storage and malformed saved data', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(readSavedRound('broken')).toBeNull();
    expect(recordResult('x', 'playing', 0)).toEqual(EMPTY_STATS);
  });
});
