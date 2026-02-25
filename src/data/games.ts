import type { Game } from '../types/game';
import sampleGameData from './sample-game.json';

type RawSampleGame = {
  appId: number;
  name: string;
  releaseDate: string;
  price?: {
    us?: { currency?: string; current?: number };
    cn?: { currency?: string; current?: number };
  };
  popularity?: {
    ccu?: number;
    owners?: number;
  };
  reviews?: {
    total?: number;
    positive?: number;
    negative?: number;
  };
  tags?: {
    userTags?: string[];
    developers?: string[];
    publishers?: string[];
  };
  hints?: {
    screenshotUrl?: string;
    funnyReview?: string;
  };
};

function inferSteamRating(positivePercent: number): Game['reviews']['steamRating'] {
  if (positivePercent >= 95) return 'Overwhelmingly Positive';
  if (positivePercent >= 85) return 'Very Positive';
  if (positivePercent >= 70) return 'Positive';
  if (positivePercent >= 45) return 'Mixed';
  if (positivePercent >= 20) return 'Negative';
  return 'Overwhelmingly Negative';
}

function inferPlayersFromTags(tags: string[]): Game['players'] {
  const normalized = tags.map(tag => tag.toLowerCase());
  const singlePlayer = normalized.some(tag => tag.includes('singleplayer') || tag.includes('single-player'));
  const multiplayer = normalized.some(
    tag => tag.includes('multiplayer') || tag.includes('multi-player') || tag.includes('co-op') || tag.includes('coop')
  );
  return {
    singlePlayer,
    multiplayer,
    online: multiplayer,
  };
}

function normalizeRawGame(raw: RawSampleGame): Game {
  const reviewPositive = raw.reviews?.positive ?? 0;
  const reviewTotal = raw.reviews?.total ?? 0;
  const positivePercent = reviewTotal > 0 ? Math.round((reviewPositive / reviewTotal) * 100) : 0;
  const userTags = raw.tags?.userTags ?? [];

  return {
    appId: raw.appId,
    name: raw.name,
    releaseDate: raw.releaseDate,
    price: {
      current: raw.price?.us?.current ?? 0,
      historicalLow: raw.price?.us?.current ?? 0,
    },
    popularity: {
      currentWeekly: raw.popularity?.ccu ?? 0,
      peakConcurrent: raw.popularity?.owners ?? 0,
    },
    reviews: {
      count: reviewTotal,
      positivePercent,
      steamRating: inferSteamRating(positivePercent),
    },
    players: inferPlayersFromTags(userTags),
    tags: {
      userTags,
      genres: [],
      developer: raw.tags?.developers?.[0] ?? '',
      publisher: raw.tags?.publishers?.[0] ?? '',
    },
    hints: {
      screenshotUrl: raw.hints?.screenshotUrl ?? '',
      funnyReview: raw.hints?.funnyReview ?? '',
    },
  };
}

const rawGames = sampleGameData as Record<string, RawSampleGame>;
export const sampleGames: Game[] = Object.values(rawGames).map(normalizeRawGame);

export function searchGames(query: string): Game[] {
  const lowerQuery = query.toLowerCase();
  return sampleGames.filter(
    game =>
      game.name.toLowerCase().includes(lowerQuery) ||
      game.tags.userTags.some(tag => tag.toLowerCase().includes(lowerQuery)) ||
      game.tags.genres.some(g => g.toLowerCase().includes(lowerQuery)) ||
      game.tags.developer.toLowerCase().includes(lowerQuery) ||
      game.tags.publisher.toLowerCase().includes(lowerQuery)
  );
}

export function getGameById(appId: number): Game | undefined {
  return sampleGames.find(game => game.appId === appId);
}

export function getRandomGame(): Game {
  return sampleGames[Math.floor(Math.random() * sampleGames.length)];
}
