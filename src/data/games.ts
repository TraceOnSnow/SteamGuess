import type { Game } from '../types/game';

const API_CATALOG_URL = '/api/catalog/games';
const STATIC_CATALOG_URL = `${import.meta.env.BASE_URL}games_demo.json`;

let cache: Promise<Game[]> | null = null;

/** Loads the searchable catalog once per page; answers carry a `difficulty`. */
export function loadGames(): Promise<Game[]> {
  cache ??= fetchGames().catch(error => { cache = null; throw error; });
  return cache;
}

async function fetchGames(): Promise<Game[]> {
  let response: Response;
  try {
    response = await fetch(API_CATALOG_URL);
    if (!response.ok) throw new Error(String(response.status));
  } catch {
    // Static hosting (or an offline API) still gets the bundled snapshot.
    response = await fetch(STATIC_CATALOG_URL);
  }
  if (!response.ok) throw new Error(`Failed to load game catalog (${response.status})`);
  const raw: unknown = await response.json();
  const games = (Array.isArray(raw) ? raw : Object.values(raw as Record<string, unknown>)).filter(isGame);
  if (!games.length) throw new Error('The game catalog is empty or invalid.');
  return games;
}

function isGame(value: unknown): value is Game {
  const game = value as Partial<Game> | null;
  return Boolean(game) && typeof game!.appId === 'number' && typeof game!.name === 'string'
    && typeof game!.releaseDate === 'string' && typeof game!.reviews?.total === 'number'
    && Array.isArray(game!.tags?.userTags) && typeof game!.price === 'object';
}

/** Lower-cases and drops spaces and punctuation so "half life 2" finds "Half-Life 2". */
export function normalizeQuery(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

const searchKeys = new WeakMap<Game, string[]>();
function keysOf(game: Game): string[] {
  let keys = searchKeys.get(game);
  if (!keys) {
    keys = [game.name, game.localizedNames?.zh, ...(game.aliases ?? [])].filter((name): name is string => Boolean(name)).map(normalizeQuery);
    searchKeys.set(game, keys);
  }
  return keys;
}

/** Exact matches first, then prefix matches, then better-known games. */
export function searchGames(games: Game[], query: string, excludedAppIds: ReadonlySet<number>, limit = 8): Game[] {
  const wanted = normalizeQuery(query);
  if (!wanted) return [];
  const scored: { game: Game; score: number }[] = [];
  for (const game of games) {
    if (excludedAppIds.has(game.appId)) continue;
    let best = 0;
    for (const key of keysOf(game)) {
      if (key === wanted) best = 3;
      else if (best < 2 && key.startsWith(wanted)) best = 2;
      else if (best < 1 && key.includes(wanted)) best = 1;
    }
    if (best) scored.push({ game, score: best });
  }
  return scored
    .sort((a, b) => b.score - a.score || b.game.reviews.total - a.game.reviews.total)
    .slice(0, limit)
    .map(item => item.game);
}

export function getRandomGame<T extends Game>(games: T[], previousAppId?: number): T {
  if (!games.length) throw new Error('Cannot choose a game from an empty catalog.');
  const choices = games.length > 1 ? games.filter(game => game.appId !== previousAppId) : games;
  return choices[Math.floor(Math.random() * choices.length)];
}
