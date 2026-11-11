import type { Game } from '../types/game';

/**
 * Practice presets: an answer pool chosen by theme instead of by tier.
 * Built-in presets read fields of the snapshot; a custom preset is a JSON list
 * of Steam AppIDs the player pastes or uploads.  Everything stays in the browser.
 */
export type PresetId = 'tga' | 'metacritic' | 'custom';
export const PRESETS: PresetId[] = ['tga', 'metacritic', 'custom'];
export const TGA_CEREMONIES = 10;
export const METACRITIC_MIN = 80;
export const CUSTOM_MIN = 3;
export const CUSTOM_MAX = 2000;

export interface CustomPreset { name: string; appIds: number[] }

/** Games from a pool that the round can deal; answers come first since only they carry screenshots. */
export function presetPool(games: Game[], id: PresetId, custom?: CustomPreset | null): Game[] {
  if (id === 'tga') {
    const latest = Math.max(0, ...games.flatMap(game => game.tga ?? []));
    return games.filter(game => game.tga?.some(year => year > latest - TGA_CEREMONIES));
  }
  if (id === 'metacritic') return games.filter(game => game.difficulty && (game.metacritic ?? 0) >= METACRITIC_MIN);
  if (!custom) return [];
  const wanted = new Set(custom.appIds);
  return games.filter(game => wanted.has(game.appId));
}

/** Latest TGA ceremony year in the data, for the preset description. */
export function tgaRange(games: Game[]): [number, number] | null {
  const latest = Math.max(0, ...games.flatMap(game => game.tga ?? []));
  return latest ? [latest - TGA_CEREMONIES + 1, latest] : null;
}

export type ParseResult = { ok: true; preset: CustomPreset } | { ok: false; error: 'json' | 'shape' | 'empty' | 'tooMany' };

/** Accepts `{"name": "...", "appIds": [730, 570]}` or a bare `[730, 570]`. */
export function parseCustomPreset(text: string): ParseResult {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ok: false, error: 'json' }; }
  const list = Array.isArray(value) ? value : (value as { appIds?: unknown } | null)?.appIds;
  if (!Array.isArray(list)) return { ok: false, error: 'shape' };
  const appIds = [...new Set(list.map(Number).filter(id => Number.isInteger(id) && id > 0))];
  if (!appIds.length) return { ok: false, error: 'empty' };
  if (appIds.length > CUSTOM_MAX) return { ok: false, error: 'tooMany' };
  const rawName = Array.isArray(value) ? '' : (value as { name?: unknown }).name;
  const name = typeof rawName === 'string' ? rawName.trim().slice(0, 40) : '';
  return { ok: true, preset: { name, appIds } };
}

export function serializeCustomPreset(preset: CustomPreset): string {
  return JSON.stringify({ name: preset.name, appIds: preset.appIds }, null, 2);
}

/** Short stable fingerprint so a changed custom list starts a fresh saved round. */
export function presetFingerprint(preset: CustomPreset | null | undefined): string {
  if (!preset) return 'none';
  let hash = 2166136261;
  for (const id of [...preset.appIds].sort((a, b) => a - b)) {
    hash ^= id; hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `${preset.appIds.length}-${hash.toString(36)}`;
}

const CUSTOM_KEY = 'steamguess-custom-preset-v1';
export function readCustomPreset(): CustomPreset | null {
  try {
    const parsed = parseCustomPreset(localStorage.getItem(CUSTOM_KEY) || '');
    return parsed.ok ? parsed.preset : null;
  } catch { return null; }
}
export function saveCustomPreset(preset: CustomPreset) {
  try { localStorage.setItem(CUSTOM_KEY, serializeCustomPreset(preset)); } catch { /* Kept for this visit only. */ }
}
