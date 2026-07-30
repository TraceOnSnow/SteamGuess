export const DISPLAY_FIELDS = [
  'price',
  'activity',
  'rating',
  'releaseDate',
  'companies',
  'tags',
  'owned',
] as const;

export type DisplayField = typeof DISPLAY_FIELDS[number];

type LegacyDisplayField = DisplayField | 'ccu' | 'reviews';

export const DEFAULT_DISPLAY_FIELDS: DisplayField[] = DISPLAY_FIELDS.filter(field => field !== 'owned');
export const DISPLAY_FIELDS_STORAGE_KEY = 'steamguess-visible-fields-v1';

export function loadDisplayFields(storage: Pick<Storage, 'getItem'> = localStorage): Set<DisplayField> {
  try {
    const raw = storage.getItem(DISPLAY_FIELDS_STORAGE_KEY);
    if (!raw) return new Set(DEFAULT_DISPLAY_FIELDS);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(DEFAULT_DISPLAY_FIELDS);

    const saved = new Set(parsed.filter((field): field is LegacyDisplayField => typeof field === 'string'));
    if (saved.has('ccu') || saved.has('reviews')) saved.add('activity');
    return new Set(DISPLAY_FIELDS.filter(field => saved.has(field)));
  } catch {
    return new Set(DEFAULT_DISPLAY_FIELDS);
  }
}

export function saveDisplayFields(fields: ReadonlySet<DisplayField>, storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(DISPLAY_FIELDS_STORAGE_KEY, JSON.stringify(DISPLAY_FIELDS.filter(field => fields.has(field))));
}
