export const STEAM_LIBRARY_STORAGE_KEY = 'steamguess-owned-library-v1';

export interface SteamLibrary {
  appIds: number[];
  source: 'profile' | 'file' | 'text';
  importedAt: string;
  steamId?: string;
  profileName?: string;
}

interface SteamLibraryApiResponse {
  steamId: string;
  profileName?: string;
  appIds: number[];
}

function asAppId(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function collectStructuredAppIds(value: unknown, output: Set<number>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'object' && item !== null && 'appid' in item) {
        const appid = asAppId((item as { appid?: unknown }).appid);
        if (appid) output.add(appid);
      } else {
        const appid = asAppId(item);
        if (appid) output.add(appid);
      }
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  for (const key of ['appids', 'appIds', 'games']) {
    if (key in record) collectStructuredAppIds(record[key], output);
  }
  if (record.response && typeof record.response === 'object') {
    collectStructuredAppIds(record.response, output);
  }
}

export function parseSteamAppIds(input: string): number[] {
  const output = new Set<number>();
  const trimmed = input.trim();
  if (!trimmed) return [];

  try {
    collectStructuredAppIds(JSON.parse(trimmed), output);
  } catch {
    for (const token of trimmed.match(/\d+/g) ?? []) {
      const appid = asAppId(token);
      if (appid) output.add(appid);
    }
  }
  return [...output].sort((a, b) => a - b);
}

export function loadSteamLibrary(storage: Pick<Storage, 'getItem'> = localStorage): SteamLibrary | null {
  try {
    const raw = storage.getItem(STEAM_LIBRARY_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<SteamLibrary>;
    if (!Array.isArray(value.appIds)) return null;
    const appIds = [...new Set(value.appIds.map(asAppId).filter((id): id is number => id !== null))];
    if (appIds.length === 0) return null;
    return {
      appIds,
      source: value.source === 'profile' || value.source === 'file' ? value.source : 'text',
      importedAt: typeof value.importedAt === 'string' ? value.importedAt : new Date().toISOString(),
      steamId: value.steamId,
      profileName: value.profileName,
    };
  } catch {
    return null;
  }
}

export function saveSteamLibrary(library: SteamLibrary, storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(STEAM_LIBRARY_STORAGE_KEY, JSON.stringify(library));
}

export function clearSteamLibrary(storage: Pick<Storage, 'removeItem'> = localStorage): void {
  storage.removeItem(STEAM_LIBRARY_STORAGE_KEY);
}

export function createLocalLibrary(appIds: number[], source: 'file' | 'text'): SteamLibrary {
  return { appIds: [...new Set(appIds)], source, importedAt: new Date().toISOString() };
}

export async function importSteamProfile(profile: string, signal?: AbortSignal): Promise<SteamLibrary> {
  const configuredEndpoint = import.meta.env.VITE_STEAM_LIBRARY_API_URL as string | undefined;
  const endpoint = configuredEndpoint || '/api/steam-library';
  const url = new URL(endpoint, window.location.origin);
  url.searchParams.set('profile', profile.trim());
  const response = await fetch(url, { signal });
  const payload = await response.json().catch(() => null) as (SteamLibraryApiResponse & { error?: string }) | null;
  if (!response.ok) throw new Error(payload?.error || `Steam library import failed (${response.status})`);
  if (!payload || !Array.isArray(payload.appIds)) throw new Error('Steam library response is invalid');
  return {
    appIds: [...new Set(payload.appIds.map(Number).filter(Number.isSafeInteger))],
    source: 'profile',
    importedAt: new Date().toISOString(),
    steamId: payload.steamId,
    profileName: payload.profileName,
  };
}

export const PROFILE_IMPORT_AVAILABLE = import.meta.env.VITE_BACKEND_ENABLED !== 'false';
