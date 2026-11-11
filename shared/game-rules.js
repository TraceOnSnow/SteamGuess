// Rules shared by the browser and the multiplayer server. Keep this file free
// of DOM and Node APIs.

export const LEVELS = Object.freeze(['beginner', 'easy', 'normal', 'hard', 'unrated']);
export const RATED_LEVELS = Object.freeze(['beginner', 'easy', 'normal', 'hard']);
export const CURRENCIES = Object.freeze(['CNY', 'USD']);
export const MAX_GUESSES = 10;
export const NUMERIC_FIELDS = Object.freeze(['price', 'popularity', 'reviews', 'rating', 'releaseDate']);

// Prices are compared in the player's own currency, so each currency has its
// own absolute thresholds. Counts are compared by percentage.
export const COMPARISON_RULES = Object.freeze({
  price: Object.freeze({
    CNY: Object.freeze({ mode: 'absolute', exact: 5, partial: 25, close: 75 }),
    USD: Object.freeze({ mode: 'absolute', exact: 1, partial: 4, close: 12 }),
  }),
  popularity: Object.freeze({ mode: 'percent', exact: 5, partial: 50, close: 100 }),
  reviewsRate: Object.freeze({ mode: 'absolute', exact: 1, partial: 5, close: 10 }),
  releaseDate: Object.freeze({ exactYears: 0.2, partialYears: 1, closeYears: 3 }),
});

/**
 * Tiers are cumulative: a harder tier contains every easier one, and
 * "unrated" (the unverified long tail) contains the whole answer list.
 * Daily puzzles and multiplayer rooms only use the rated tiers.
 */
export function isLevelInPool(level, pool) {
  const index = LEVELS.indexOf(level);
  return index >= 0 && index <= LEVELS.indexOf(pool);
}

export function isAnswer(game) {
  return LEVELS.includes(game?.difficulty?.level);
}

export function answerPool(games, pool) {
  return games.filter(game => isAnswer(game) && isLevelInPool(game.difficulty.level, pool));
}

export function getPlayerPeak(game) {
  return game.popularity?.peak7d ?? game.popularity?.peakYesterday ?? game.popularity?.ccu;
}

export function getRegularPrice(game, currency = 'CNY') {
  const value = game.price?.[currency === 'USD' ? 'us' : 'cn']?.regular;
  return Number.isFinite(value) ? value : undefined;
}

export function getPositiveRate(game) {
  return game.reviews?.total > 0 ? game.reviews.positive / game.reviews.total * 100 : undefined;
}

export function numericDistance(user, correct, mode) {
  if (mode === 'absolute') return Math.abs(user - correct);
  if (correct === 0) return user === 0 ? 0 : Number.POSITIVE_INFINITY;
  return Math.abs(user - correct) / Math.abs(correct) * 100;
}

export function statusByDistance(distance, rule) {
  if (distance <= rule.exact) return 'exact';
  if (distance <= rule.partial) return 'partial';
  if (distance <= rule.close) return 'close';
  return 'wrong';
}

export function comparisonDirection(user, correct, status) {
  if (user === correct) return 'equal';
  if (status === 'exact') return 'near';
  return correct > user ? 'higher' : 'lower';
}

export function compareNumericValues(user, correct, rule) {
  if (!Number.isFinite(user) || !Number.isFinite(correct)) return { status: 'unknown' };
  const status = statusByDistance(numericDistance(user, correct, rule.mode), rule);
  return { status, direction: comparisonDirection(user, correct, status) };
}

/** Accepts ISO dates plus the Storefront formats found in older snapshots. */
export function parseReleaseDate(value) {
  if (typeof value !== 'string') return Number.NaN;
  const text = value.trim();
  if (!text) return Number.NaN;

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

  const yearOnly = text.match(/^(\d{4})$/);
  if (yearOnly) return Date.UTC(Number(yearOnly[1]), 0, 1);

  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

export function compareDateValues(userDate, correctDate, thresholds = COMPARISON_RULES.releaseDate) {
  const user = parseReleaseDate(userDate);
  const correct = parseReleaseDate(correctDate);
  if (!Number.isFinite(user) || !Number.isFinite(correct)) return { status: 'unknown' };
  const years = Math.abs(user - correct) / 86400000 / 365.2425;
  const status = years <= thresholds.exactYears ? 'exact'
    : years <= thresholds.partialYears ? 'partial'
      : years <= thresholds.closeYears ? 'close' : 'wrong';
  return { status, direction: comparisonDirection(user, correct, status) };
}

function sharedValues(guess, answer) {
  const wanted = new Set((answer ?? []).map(value => String(value).toLocaleLowerCase()));
  return (guess ?? []).filter(value => wanted.has(String(value).toLocaleLowerCase()));
}

/**
 * The single source of truth for a guess. `fields` carries only status and
 * direction; the UI reads the displayed values from the guessed game itself.
 */
export function compareGames(guess, answer, currency = 'CNY') {
  const priceRule = COMPARISON_RULES.price[currency] ?? COMPARISON_RULES.price.CNY;
  const companies = game => [...new Set([...(game.tags?.developers ?? []), ...(game.tags?.publishers ?? [])])];
  return {
    isCorrect: guess.appId === answer.appId,
    fields: {
      price: compareNumericValues(getRegularPrice(guess, currency), getRegularPrice(answer, currency), priceRule),
      popularity: compareNumericValues(getPlayerPeak(guess), getPlayerPeak(answer), COMPARISON_RULES.popularity),
      reviews: compareNumericValues(guess.reviews?.total, answer.reviews?.total, COMPARISON_RULES.popularity),
      rating: compareNumericValues(getPositiveRate(guess), getPositiveRate(answer), COMPARISON_RULES.reviewsRate),
      releaseDate: compareDateValues(guess.releaseDate, answer.releaseDate),
    },
    matchingTags: sharedValues(guess.tags?.userTags, answer.tags?.userTags),
    matchingCompanies: sharedValues(companies(guess), companies(answer)),
  };
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Everyone gets the same daily answer. The pool is reshuffled once per cycle
 * so the order is not guessable from AppIDs and no game repeats within a cycle.
 */
export function dailyGame(games, day) {
  if (!games.length) throw new Error('The answer pool is empty.');
  const ordered = [...games].sort((a, b) => a.appId - b.appId);
  const days = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86400000);
  const size = ordered.length;
  const cycle = Math.floor(days / size);
  const random = mulberry32(cycle * 2654435761 + size);
  for (let index = size - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [ordered[index], ordered[other]] = [ordered[other], ordered[index]];
  }
  return ordered[((days % size) + size) % size];
}
