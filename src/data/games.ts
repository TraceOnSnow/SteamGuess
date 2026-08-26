import { localizedGameNames } from './localization';
import type { Game, ScoredGame } from '../types/game';

const API_CATALOG_URL = '/api/catalog/games';
const STATIC_CATALOG_URL = `${import.meta.env.BASE_URL}games_demo.json`;


export interface GameExperience {
  games: Game[];
}

/** Load the searchable catalog. Only scored rows are eligible as answers. */
export async function loadGameExperience(signal?: AbortSignal): Promise<GameExperience> {
  return { games: await loadGames(signal) };
}

export async function loadGames(signal?: AbortSignal): Promise<Game[]> {
  let response: Response;
  try {
    response = await fetch(API_CATALOG_URL, { signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`Dynamic catalog returned ${response.status}`);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    response = await fetch(STATIC_CATALOG_URL, { signal, cache: 'no-store' });
  }
  if (!response.ok) throw new Error(`Failed to load game catalog (${response.status})`);

  const raw: unknown = await response.json();
  const games = Array.isArray(raw) ? raw : Object.values(raw as Record<string, unknown>);
  const validGames = games.filter(isGame);

  if (validGames.length === 0) throw new Error('The game catalog is empty or invalid.');
  return validGames;
}

export function searchGames(games: Game[], query: string, excludedAppIds: ReadonlySet<number>, limit = 10): Game[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];

  return games
    .filter(game => !excludedAppIds.has(game.appId) && localizedGameNames(game).some(name => name.toLocaleLowerCase().includes(normalized)))
    .sort((a, b) => {
      const aName = localizedGameNames(a).find(name => name.toLocaleLowerCase().includes(normalized))?.toLocaleLowerCase() ?? a.name.toLocaleLowerCase();
      const bName = localizedGameNames(b).find(name => name.toLocaleLowerCase().includes(normalized))?.toLocaleLowerCase() ?? b.name.toLocaleLowerCase();
      const aStarts = aName.startsWith(normalized);
      const bStarts = bName.startsWith(normalized);
      if (aStarts !== bStarts) return aStarts ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}

export function getRandomGame<T extends Game>(games: T[], previousAppId?: number): T {
  if (games.length === 0) throw new Error('Cannot choose a game from an empty catalog.');
  if (games.length === 1) return games[0];

  let game = games[Math.floor(Math.random() * games.length)];
  while (game.appId === previousAppId) {
    game = games[Math.floor(Math.random() * games.length)];
  }
  return game;
}

export function hasDifficulty(game: Game): game is ScoredGame {
  return typeof game.difficulty?.score === 'number'
    && Number.isFinite(game.difficulty.score)
    && game.difficulty.score >= 0
    && game.difficulty.score <= 100
    && ['beginner', 'easy', 'normal', 'hard', 'hell'].includes(game.difficulty.level);
}

function isGame(value: unknown): value is Game {
  if (!value || typeof value !== 'object') return false;
  const game = value as Partial<Game>;
  return typeof game.appId === 'number'
    && typeof game.name === 'string'
    && typeof game.releaseDate === 'string'
    && typeof game.price?.us?.regular === 'number'
    && typeof game.popularity?.ccu === 'number'
    && typeof game.reviews?.total === 'number'
    && Array.isArray(game.tags?.userTags)
    && (game.difficulty === undefined || hasDifficulty(game as Game));
}
