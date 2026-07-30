import { localizedGameNames } from './localization';
import type { Game } from '../types/game';
import { loadLabelingCatalog } from '../labeler/data';
import { loadStoredLabels } from '../labeler/labels';
import { loadDifficultyModel, saveDifficultyModel, trainDifficultyModel, type DifficultyModel } from '../difficulty/model';

const CATALOG_URL = `${import.meta.env.BASE_URL}games_demo.json`;


export interface GameExperience {
  games: Game[];
  model: DifficultyModel | null;
}

export async function loadGameExperience(signal?: AbortSignal): Promise<GameExperience> {
  const games = await loadGames(signal);
  try {
    const catalog = await loadLabelingCatalog(signal);
    const labels = loadStoredLabels();
    const trained = trainDifficultyModel(catalog.games, labels);
    const model = trained ?? loadDifficultyModel();
    if (trained) saveDifficultyModel(trained);
    const metadata = new Map(catalog.games.map(game => [game.appId, game]));
    const playable = games
      .map(game => {
        const catalogGame = metadata.get(game.appId);
        const prediction = model?.predictions[String(game.appId)];
        const manuallyExcluded = labels.get(game.appId)?.excluded === true;
        const software = catalogGame?.appType?.toLocaleLowerCase() === 'application';
        if (prediction?.excluded || manuallyExcluded || software) return null;
        if (prediction) {
          return {
            ...game,
            localizedNames: catalogGame?.localizedNames ?? game.localizedNames,
            difficulty: {
              level: prediction.level,
              score: prediction.score,
              confidence: prediction.confidence,
              source: prediction.source,
            },
          };
        }
        return catalogGame ? {
          ...game,
          localizedNames: catalogGame.localizedNames ?? game.localizedNames,
          difficulty: {
            level: catalogGame.suggestedLevel,
            score: Math.round((100 - catalogGame.recognitionScore) * 10) / 10,
            confidence: 0,
            source: 'fallback' as const,
          },
        } : game;
      })
      .filter((game): game is Game => Boolean(game));
    return { games: playable, model };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    console.warn('Difficulty model unavailable; using the base game catalog.', error);
    return { games, model: null };
  }
}

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
    && typeof game.price?.us?.regular === 'number'
    && typeof game.popularity?.ccu === 'number'
    && typeof game.reviews?.total === 'number'
    && Array.isArray(game.tags?.userTags);
}
