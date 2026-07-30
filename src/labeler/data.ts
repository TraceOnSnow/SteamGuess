import { localizedGameNames } from '../data/localization';
import type { LabelingCatalog, LabelingGame } from './types';

const CATALOG_URL = `${import.meta.env.BASE_URL}labeling_catalog.json`;

export async function loadLabelingCatalog(signal?: AbortSignal): Promise<LabelingCatalog> {
  const response = await fetch(CATALOG_URL, { signal });
  if (!response.ok) throw new Error(`标注目录加载失败（${response.status}）`);
  const payload: unknown = await response.json();
  if (!isCatalog(payload)) throw new Error('标注目录格式无效');
  return payload;
}

export function searchLabelingGames(games: LabelingGame[], query: string, limit = 8): LabelingGame[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];
  const appIdQuery = Number.parseInt(normalized, 10);
  return games
    .filter(game => localizedGameNames(game).some(name => name.toLocaleLowerCase().includes(normalized)) || game.appId === appIdQuery)
    .sort((left, right) => {
      if (left.appId === appIdQuery) return -1;
      if (right.appId === appIdQuery) return 1;
      const leftStarts = localizedGameNames(left).some(name => name.toLocaleLowerCase().startsWith(normalized));
      const rightStarts = localizedGameNames(right).some(name => name.toLocaleLowerCase().startsWith(normalized));
      if (leftStarts !== rightStarts) return leftStarts ? -1 : 1;
      return right.recognitionScore - left.recognitionScore;
    })
    .slice(0, limit);
}

export function chooseRandomUnlabeled(
  games: LabelingGame[],
  labeledAppIds: ReadonlySet<number>,
  previousAppId?: number,
  random = Math.random,
): LabelingGame | null {
  const candidates = games.filter(game => !labeledAppIds.has(game.appId) && game.appId !== previousAppId);
  if (candidates.length === 0) {
    return games.find(game => !labeledAppIds.has(game.appId)) ?? null;
  }
  return candidates[Math.floor(random() * candidates.length)] ?? candidates[0] ?? null;
}

function isCatalog(value: unknown): value is LabelingCatalog {
  if (!value || typeof value !== 'object') return false;
  const catalog = value as Partial<LabelingCatalog>;
  return catalog.schemaVersion === 1
    && typeof catalog.generatedAt === 'string'
    && typeof catalog.sourceCatalog === 'string'
    && Array.isArray(catalog.games)
    && catalog.games.length > 0
    && catalog.games.every(isGame);
}

function isGame(value: unknown): value is LabelingGame {
  if (!value || typeof value !== 'object') return false;
  const game = value as Partial<LabelingGame>;
  return typeof game.appId === 'number'
    && typeof game.name === 'string'
    && typeof game.recognitionScore === 'number'
    && Array.isArray(game.developers)
    && Array.isArray(game.userTags)
    && !!game.metrics;
}
