import type { Game } from '../../types/game';

export type MetadataKind = 'developer' | 'publisher' | 'user';

export interface CompanyMetadata {
  value: string;
  kinds: Array<Exclude<MetadataKind, 'user'>>;
}

export function buildMetadataMatchSets(game: Game): Record<MetadataKind, Set<string>> {
  return {
    developer: new Set(game.tags.developers.map(tag => tag.toLocaleLowerCase())),
    publisher: new Set(game.tags.publishers.map(tag => tag.toLocaleLowerCase())),
    user: new Set(game.tags.userTags.map(tag => tag.toLocaleLowerCase())),
  };
}

export function orderByMatch(values: string[], matches: ReadonlySet<string>): string[] {
  return values
    .map((value, index) => ({ value, index, shared: matches.has(value.toLocaleLowerCase()) }))
    .sort((a, b) => Number(b.shared) - Number(a.shared) || a.index - b.index)
    .map(item => item.value);
}

export function getCompanies(game: Game): CompanyMetadata[] {
  const companies = new Map<string, CompanyMetadata>();

  const add = (value: string, kind: Exclude<MetadataKind, 'user'>) => {
    const key = value.toLocaleLowerCase();
    const existing = companies.get(key);
    if (existing) {
      if (!existing.kinds.includes(kind)) existing.kinds.push(kind);
      return;
    }
    companies.set(key, { value, kinds: [kind] });
  };

  game.tags.developers.forEach(value => add(value, 'developer'));
  game.tags.publishers.forEach(value => add(value, 'publisher'));
  return [...companies.values()];
}

export function isSharedCompany(
  company: CompanyMetadata,
  matches: Pick<Record<MetadataKind, Set<string>>, 'developer' | 'publisher'>,
): boolean {
  const normalized = company.value.toLocaleLowerCase();
  return company.kinds.some(kind => matches[kind].has(normalized));
}
