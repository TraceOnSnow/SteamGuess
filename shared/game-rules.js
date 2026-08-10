export const COMPARISON_RULES = Object.freeze({
  price: Object.freeze({ mode: 'absolute', exact: 5, partial: 25, close: 75 }),
  popularity: Object.freeze({ mode: 'percent', exact: 5, partial: 50, close: 100 }),
  reviewsRate: Object.freeze({ mode: 'absolute', exact: 1, partial: 5, close: 10 }),
  releaseDate: Object.freeze({ exactYears: 0.2, partialYears: 1, closeYears: 3 }),
});

export function getPlayerPeak(game) { return game.popularity?.peak7d ?? game.popularity?.peakYesterday ?? game.popularity?.ccu; }
export function getRegularPrice(game) { const value = game.price?.cn?.regular; return Number.isFinite(value) ? value : undefined; }
export function getPositiveRate(game) { return game.reviews?.total > 0 ? game.reviews.positive / game.reviews.total * 100 : 0; }
export function numericDistance(user, correct, mode) { if (mode === 'absolute') return Math.abs(user - correct); if (correct === 0) return user === 0 ? 0 : 100; return Math.abs(user - correct) / Math.abs(correct) * 100; }
export function statusByDistance(distance, rule) { if (distance <= rule.exact) return 'exact'; if (distance <= rule.partial) return 'partial'; if (distance <= rule.close) return 'close'; return 'wrong'; }
export function comparisonDirection(user, correct, status) { if (user === correct) return 'equal'; if (status === 'exact') return 'near'; return correct > user ? 'higher' : 'lower'; }
export function compareNumericValues(user, correct, rule) { if (!Number.isFinite(user) || !Number.isFinite(correct)) return { status: 'unknown' }; const status = statusByDistance(numericDistance(user, correct, rule.mode), rule); return { status, direction: comparisonDirection(user, correct, status) }; }
export function parseReleaseDate(value) {
  if (typeof value !== 'string') return Number.NaN;
  const text = value.trim();
  if (!text) return Number.NaN;

  // Steam's Simplified Chinese Storefront response uses e.g.
  // "2016 年 2 月 26 日", which Date.parse does not understand.
  const chinese = text.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?$/);
  if (chinese) {
    const year = Number(chinese[1]);
    const month = Number(chinese[2]);
    const day = Number(chinese[3] || 1);
    const timestamp = Date.UTC(year, month - 1, day);
    const date = new Date(timestamp);
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) return timestamp;
    return Number.NaN;
  }

  // A year-only release date is still useful for a coarse comparison.
  const yearOnly = text.match(/^(\d{4})$/);
  if (yearOnly) return Date.UTC(Number(yearOnly[1]), 0, 1);

  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

export function compareDateValues(userDate, correctDate, thresholds = COMPARISON_RULES.releaseDate) { const user = parseReleaseDate(userDate); const correct = parseReleaseDate(correctDate); if (!Number.isFinite(user) || !Number.isFinite(correct)) return { status: 'unknown' }; const days = Math.abs(user - correct) / 86400000; const status = days <= thresholds.exactYears * 365.2425 ? 'exact' : days <= thresholds.partialYears * 365.2425 ? 'partial' : days <= thresholds.closeYears * 365.2425 ? 'close' : 'wrong'; return { status, direction: comparisonDirection(user, correct, status) }; }
