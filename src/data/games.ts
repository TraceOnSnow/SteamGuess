import type { Game } from '../types/game';

const CATALOG_URL = `${import.meta.env.BASE_URL}games_demo.json`;

export async function loadGames(signal?: AbortSignal): Promise<Game[]> {
  const response = await fetch(CATALOG_URL, { signal });
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
    .filter(game => !excludedAppIds.has(game.appId) && game.name.toLocaleLowerCase().includes(normalized))
    .sort((a, b) => {
      const aName = a.name.toLocaleLowerCase();
      const bName = b.name.toLocaleLowerCase();
      const aStarts = aName.startsWith(normalized);
      const bStarts = bName.startsWith(normalized);
      if (aStarts !== bStarts) return aStarts ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}

export function getRandomGame(games: Game[], previousAppId?: number): Game {
  if (games.length === 0) throw new Error('Cannot choose a game from an empty catalog.');
  if (games.length === 1) return games[0];

  let game = games[Math.floor(Math.random() * games.length)];
  while (game.appId === previousAppId) {
    game = games[Math.floor(Math.random() * games.length)];
  }
  return game;
}

function isGame(value: unknown): value is Game {
  if (!value || typeof value !== 'object') return false;
  const game = value as Partial<Game>;
  return typeof game.appId === 'number'
    && typeof game.name === 'string'
    && typeof game.releaseDate === 'string'
    && typeof game.price?.us?.current === 'number'
    && typeof game.popularity?.ccu === 'number'
    && typeof game.reviews?.total === 'number'
    && Array.isArray(game.tags?.userTags);
}
