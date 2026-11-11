import { afterEach, describe, expect, it, vi } from 'vitest';
import published from '../../public/games_demo.json?raw';
import edition from '../../shared/edition.json';
import { compareGames, dailyGame, isLevelInPool } from '../../shared/game-rules.js';
import { game } from '../data/games.test';
import { searchGames } from '../data/games';
import type { Game } from '../types/game';
import { summarize } from './knowledge';
import { parseCustomPreset, presetFingerprint, presetPool } from './presets';
import { challengeUrl, decodeChallenge, encodeChallenge } from './share';
import { EMPTY_STATS, readSavedRound, recordResult, roundKey, saveRound, type SavedRound } from './progress';
import { DAILY_LEVEL, LEVELS, POOL_SIZES, answerPool } from './rules';

const games: Game[] = Object.values(JSON.parse(published));
afterEach(() => vi.unstubAllGlobals());

describe('comparison rules', () => {
  const answer = game(1, 'Answer', { releaseDate: '2018-06-01', tags: { userTags: ['RPG', 'Open World'], developers: ['Studio A'], publishers: ['Pub'] } });
  it('grades each clue by distance and points towards the answer', () => {
    const guess = game(2, 'Guess', {
      price: { us: { regular: 13 }, cn: { regular: 120 } }, popularity: { ccu: 250 },
      reviews: { total: 103, positive: 95, negative: 8 }, releaseDate: '2021-01-01',
      tags: { userTags: ['rpg', 'Shooter'], developers: ['Other'], publishers: ['pub'] },
    });
    const result = compareGames(guess, answer, 'CNY');
    expect(result.isCorrect).toBe(false);
    expect(result.fields.price).toEqual({ status: 'close', direction: 'lower' });
    expect(result.fields.popularity).toEqual({ status: 'wrong', direction: 'lower' });
    expect(result.fields.reviews).toEqual({ status: 'exact', direction: 'near' });
    expect(result.fields.releaseDate).toEqual({ status: 'close', direction: 'lower' });
    expect(result.matchingTags).toEqual(['rpg']);
    expect(result.matchingCompanies).toEqual(['pub']);
  });
  it('compares prices in the requested currency with its own thresholds', () => {
    const guess = game(2, 'Guess', { price: { us: { regular: 13 }, cn: { regular: 120 } } });
    expect(compareGames(guess, answer, 'USD').fields.price).toEqual({ status: 'partial', direction: 'lower' });
    expect(compareGames(guess, answer, 'CNY').fields.price.status).toBe('close');
  });
  it('reports missing data as unknown instead of guessing', () => {
    const unsold = game(3, 'Unsold', { price: { us: { regular: null }, cn: { regular: null } }, releaseDate: '' });
    const result = compareGames(unsold, answer, 'USD');
    expect(result.fields.price).toEqual({ status: 'unknown' });
    expect(result.fields.releaseDate).toEqual({ status: 'unknown' });
  });
  it('marks the answer itself as correct on every clue', () => {
    const result = compareGames(answer, answer, 'CNY');
    expect(result.isCorrect).toBe(true);
    expect(Object.values(result.fields).every(field => field.status === 'exact' && field.direction === 'equal')).toBe(true);
  });
});

describe('knowledge summary', () => {
  it('keeps the tightest range and every confirmed tag', () => {
    const answer = game(1, 'Answer', { price: { us: { regular: 30 }, cn: { regular: 150 } }, tags: { userTags: ['RPG', 'Co-op'], developers: [], publishers: [] } });
    const records = [
      game(2, 'Cheap', { price: { us: { regular: 5 }, cn: { regular: 20 } }, tags: { userTags: ['RPG'], developers: [], publishers: [] } }),
      game(3, 'Closer', { price: { us: { regular: 10 }, cn: { regular: 60 } }, tags: { userTags: ['Co-op'], developers: [], publishers: [] } }),
      game(4, 'Pricey', { price: { us: { regular: 60 }, cn: { regular: 298 } } }),
    ].map(guess => ({ game: guess, result: compareGames(guess, answer, 'CNY') }));
    const known = summarize(records, 'CNY');
    expect(known.bounds.price).toEqual({ min: 60, max: 298 });
    expect(known.bounds.rating).toEqual({ exact: 90 });
    expect(known.tags).toEqual(['RPG', 'Co-op']);
  });
});

describe('difficulty pools and the daily answer', () => {
  it('nests every tier inside the next one', () => {
    expect(isLevelInPool('beginner', 'hard')).toBe(true);
    expect(isLevelInPool('hard', 'normal')).toBe(false);
    expect(isLevelInPool('hard', 'unrated')).toBe(true);
    expect(isLevelInPool('unrated', 'hard')).toBe(false);
  });
  it('gives everyone the same daily answer and walks the whole pool without repeats', () => {
    const pool = Array.from({ length: 30 }, (_, index) => game(index + 1, `G${index}`));
    expect(dailyGame(pool, '2026-10-23').appId).toBe(dailyGame([...pool].reverse(), '2026-10-23').appId);
    const start = Math.ceil(Date.UTC(2026, 0, 1) / 86400000 / 30) * 30;
    const ids = Array.from({ length: 30 }, (_, index) => dailyGame(pool, new Date((start + index) * 86400000).toISOString().slice(0, 10)).appId);
    expect(new Set(ids).size).toBe(30);
    expect(ids).not.toEqual([...ids].sort((a, b) => a - b));
  });
});

describe('published snapshot', () => {
  const answers = games.filter(item => item.difficulty);
  it('matches the edition sizes and nests the tiers', () => {
    expect(answers).toHaveLength(edition.answerLimit);
    expect(games.length).toBeGreaterThanOrEqual(1500);
    expect(games.length).toBeLessThanOrEqual(edition.searchLimit);
    expect(LEVELS.map(level => answerPool(games, level).length)).toEqual(LEVELS.map(level => POOL_SIZES[level]));
    expect(answerPool(games, DAILY_LEVEL)).toHaveLength(POOL_SIZES[DAILY_LEVEL]);
  });
  it('gives every game its clue data and every answer a screenshot', () => {
    for (const item of games) {
      expect(item.releaseDate, item.name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(item.tags.userTags.length, item.name).toBeGreaterThan(0);
      expect(item.reviews.total, item.name).toBeGreaterThan(0);
      expect(compareGames(item, item, 'USD').isCorrect).toBe(true);
      if (item.difficulty) expect(item.hints?.screenshotUrls.length, item.name).toBeGreaterThan(0);
      else expect(item.hints).toBeUndefined();
    }
  });
  it('finds well-known nicknames', () => {
    expect(searchGames(games, '老头环', new Set())[0].appId).toBe(1245620);
    expect(searchGames(games, 'GTA5', new Set())[0].appId).toBe(271590);
    expect(searchGames(games, 'cs2', new Set())[0].appId).toBe(730);
  });
});

describe('local progress', () => {
  function storage() {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  }
  it('restores a round and counts a finished session exactly once', () => {
    storage();
    const key = roundKey('2026-10-23', 'hard');
    const round: SavedRound = { answerAppId: 730, guesses: [440], phase: 'playing', level: 'hard', session: { id: 'session_a', startedAt: '2026-10-23' }, hint: 'blurred' };
    saveRound(key, round);
    expect(readSavedRound(key)).toEqual(round);
    expect(roundKey(undefined, 'easy')).not.toBe(roundKey(undefined, 'hard'));
    expect(recordResult('session_a', 'won', 3)).toMatchObject({ played: 1, won: 1, best: 3, streak: 1 });
    expect(recordResult('session_a', 'won', 3).played).toBe(1);
    expect(recordResult('session_b', 'lost', 8)).toMatchObject({ played: 2, won: 1, streak: 0 });
  });
  it('survives blocked storage and malformed saved data', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(readSavedRound('broken')).toBeNull();
    expect(recordResult('x', 'playing', 0)).toEqual(EMPTY_STATS);
  });
});

describe('practice presets', () => {
  const base = { name: 'x', releaseDate: '2020-01-01', price: { us: { regular: 1 }, cn: { regular: 1 } }, popularity: { ccu: 1 }, reviews: { total: 1, positive: 1, negative: 0 }, tags: { userTags: [], developers: [], publishers: [] } };
  const games = [
    { ...base, appId: 1, tga: [2014], metacritic: 90, difficulty: { level: 'hard' as const } },
    { ...base, appId: 2, tga: [2016, 2025], metacritic: 79, difficulty: { level: 'beginner' as const } },
    { ...base, appId: 3, metacritic: 85 },
  ];

  it('keeps the last ten TGA ceremonies and answers scoring 80+', () => {
    expect(presetPool(games, 'tga').map(game => game.appId)).toEqual([2]);
    expect(presetPool(games, 'metacritic').map(game => game.appId)).toEqual([1]);
  });

  it('parses custom lists and ignores junk ids', () => {
    expect(parseCustomPreset('[730, "570", 730, -1, 1.5]')).toEqual({ ok: true, preset: { name: '', appIds: [730, 570] } });
    expect(parseCustomPreset('{"name": " Mine ", "appIds": [3, 1]}')).toEqual({ ok: true, preset: { name: 'Mine', appIds: [3, 1] } });
    expect(parseCustomPreset('{"ids": [1]}')).toEqual({ ok: false, error: 'shape' });
    expect(parseCustomPreset('nope')).toEqual({ ok: false, error: 'json' });
    expect(presetPool(games, 'custom', { name: '', appIds: [3, 99] }).map(game => game.appId)).toEqual([3]);
    expect(presetFingerprint({ name: 'a', appIds: [1, 2] })).toBe(presetFingerprint({ name: 'b', appIds: [2, 1] }));
  });
});

describe('share links', () => {
  it('round-trips the answer without showing the AppID', () => {
    for (const appId of [10, 730, 292030, 4435490]) {
      expect(decodeChallenge(encodeChallenge(appId))).toBe(appId);
      expect(encodeChallenge(appId)).not.toContain(String(appId));
    }
    expect(challengeUrl('https://example.test', 730)).toMatch(/^https:\/\/example\.test\/singleplayer\?g=[0-9a-z]+$/);
    expect(decodeChallenge('NOT-valid')).toBeNull();
    expect(decodeChallenge(null)).toBeNull();
  });
});
