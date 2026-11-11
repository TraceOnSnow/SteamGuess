import { getPlayerPeak, getPositiveRate, getRegularPrice, parseReleaseDate } from '../../shared/game-rules.js';
import type { Currency, NumericField } from '../../shared/game-rules.js';
import type { Game } from '../types/game';

export type Language = 'zh' | 'en';

/** Chinese players compare mainland prices; everyone else compares US prices. */
export function currencyFor(language: string): Currency {
  return language.startsWith('zh') ? 'CNY' : 'USD';
}

export function displayName(game: Pick<Game, 'name' | 'localizedNames'>, language: string): string {
  return (language.startsWith('zh') && game.localizedNames?.zh) || game.name;
}

/** The other-language name, shown as a secondary line when it differs. */
export function secondaryName(game: Pick<Game, 'name' | 'localizedNames'>, language: string): string {
  const zh = game.localizedNames?.zh;
  if (!zh || zh === game.name) return '';
  return language.startsWith('zh') ? game.name : zh;
}

export function formatPrice(value: number, currency: Currency, freeLabel: string): string {
  if (value === 0) return freeLabel;
  const digits = Number.isInteger(value) ? 0 : 2;
  return `${currency === 'CNY' ? '¥' : '$'}${value.toFixed(digits)}`;
}

export function formatCount(value: number, language: string): string {
  if (language.startsWith('zh')) {
    if (value >= 1e8) return `${trim(value / 1e8)}亿`;
    if (value >= 1e4) return `${trim(value / 1e4)}万`;
    return String(Math.round(value));
  }
  if (value >= 1e6) return `${trim(value / 1e6)}M`;
  if (value >= 1e3) return `${trim(value / 1e3)}K`;
  return String(Math.round(value));
}

function trim(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '');
}

export function formatDate(value: string, language: string): string {
  const timestamp = parseReleaseDate(value);
  if (!Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  if (language.startsWith('zh')) return `${year}年${month}月`;
  return `${date.toLocaleString('en', { month: 'short', timeZone: 'UTC' })} ${year}`;
}

/** Raw comparable value of a clue field, or undefined when the data is missing. */
export function fieldValue(game: Game, field: NumericField, currency: Currency): number | undefined {
  switch (field) {
    case 'price': return getRegularPrice(game, currency);
    case 'popularity': return getPlayerPeak(game);
    case 'reviews': return game.reviews.total;
    case 'rating': return getPositiveRate(game);
    case 'releaseDate': { const time = parseReleaseDate(game.releaseDate); return Number.isFinite(time) ? time : undefined; }
  }
}

export function formatField(value: number | undefined, field: NumericField, currency: Currency, language: string, freeLabel: string): string {
  if (value === undefined) return '—';
  switch (field) {
    case 'price': return formatPrice(value, currency, freeLabel);
    case 'popularity':
    case 'reviews': return formatCount(value, language);
    case 'rating': return `${Math.round(value)}%`;
    case 'releaseDate': return formatDate(new Date(value).toISOString().slice(0, 10), language);
  }
}
