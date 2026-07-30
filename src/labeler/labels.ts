import type { DifficultyLabel, DifficultyLevel } from './types';

export const STORAGE_KEY = 'steamguess-difficulty-labels-v1';
const LEVELS = new Set<DifficultyLevel>(['easy', 'normal', 'hard', 'hell']);

export function loadStoredLabels(storage: Pick<Storage, 'getItem'> = localStorage): Map<number, DifficultyLabel> {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return new Map();
  try {
    return parseLabels(JSON.parse(raw));
  } catch {
    return new Map();
  }
}

export function saveStoredLabels(
  labels: ReadonlyMap<number, DifficultyLabel>,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  storage.setItem(STORAGE_KEY, JSON.stringify([...labels.values()]));
}

export function parseLabels(payload: unknown): Map<number, DifficultyLabel> {
  const possibleObject = payload && typeof payload === 'object' ? payload as { labels?: unknown } : null;
  const items = Array.isArray(payload) ? payload : possibleObject?.labels;
  if (!Array.isArray(items)) throw new Error('文件中没有 labels 数组');

  const result = new Map<number, DifficultyLabel>();
  for (const value of items) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Partial<DifficultyLabel>;
    const appId = Number(item.appId);
    const excluded = item.excluded === true;
    const level = item.level ?? null;
    const score = typeof item.score === 'number' && Number.isFinite(item.score)
      ? Math.max(0, Math.min(100, item.score))
      : undefined;
    if (!Number.isInteger(appId) || appId <= 0) continue;
    if (!excluded && !LEVELS.has(level as DifficultyLevel)) continue;
    result.set(appId, {
      appId,
      level: LEVELS.has(level as DifficultyLevel) ? level as DifficultyLevel : null,
      score,
      excluded,
      reviewedAt: typeof item.reviewedAt === 'string' ? item.reviewedAt : new Date().toISOString(),
      automatic: item.automatic === true,
      excludedReason: item.excludedReason === 'software' ? 'software' : item.excludedReason === 'manual' ? 'manual' : undefined,
    });
  }
  return result;
}

export function buildExportPayload(labels: ReadonlyMap<number, DifficultyLabel>, catalog: string) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceCatalog: catalog,
    labels: [...labels.values()].sort((left, right) => left.appId - right.appId),
  };
}


export function isSoftwareApp(appType?: string | null): boolean {
  return appType?.toLocaleLowerCase() === 'application';
}

export function applyAutomaticSoftwareExclusions(
  labels: ReadonlyMap<number, DifficultyLabel>,
  games: ReadonlyArray<{ appId: number; appType?: string | null }>,
  now = () => new Date().toISOString(),
): { labels: Map<number, DifficultyLabel>; changed: number } {
  const next = new Map(labels);
  let changed = 0;
  for (const game of games) {
    if (!isSoftwareApp(game.appType)) continue;
    const existing = next.get(game.appId);
    if (existing?.excluded && existing.excludedReason === 'software') continue;
    next.set(game.appId, {
      appId: game.appId,
      level: null,
      excluded: true,
      reviewedAt: existing?.reviewedAt ?? now(),
      automatic: true,
      excludedReason: 'software',
    });
    changed += 1;
  }
  return { labels: next, changed };
}
