import { NUMERIC_FIELDS } from '../../shared/game-rules.js';
import type { Comparison, Currency, NumericField } from '../../shared/game-rules.js';
import { fieldValue } from '../lib/format';
import type { Game } from '../types/game';

export interface GuessRecord { game: Game; result: Comparison }
export interface Bound { min?: number; max?: number; near?: number; exact?: number }
export interface Knowledge { bounds: Partial<Record<NumericField, Bound>>; tags: string[]; companies: string[] }

/**
 * Folds every guess into what is known so far: the tightest range per
 * numeric clue and every tag or company confirmed to be shared.
 */
export function summarize(records: GuessRecord[], currency: Currency): Knowledge {
  const bounds: Knowledge['bounds'] = {};
  const tags = new Map<string, string>();
  const companies = new Map<string, string>();
  for (const { game, result } of records) {
    for (const field of NUMERIC_FIELDS) {
      const { direction } = result.fields[field];
      const value = fieldValue(game, field, currency);
      if (!direction || value === undefined) continue;
      const bound = bounds[field] ??= {};
      if (direction === 'equal') bound.exact = value;
      else if (direction === 'near') bound.near = value;
      else if (direction === 'higher') bound.min = Math.max(bound.min ?? value, value);
      else bound.max = Math.min(bound.max ?? value, value);
    }
    for (const tag of result.matchingTags) tags.set(tag.toLocaleLowerCase(), tag);
    for (const company of result.matchingCompanies) companies.set(company.toLocaleLowerCase(), company);
  }
  return { bounds, tags: [...tags.values()], companies: [...companies.values()] };
}
