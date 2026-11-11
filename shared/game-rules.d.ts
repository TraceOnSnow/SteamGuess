import type { Game } from '../src/types/game';

export type Level = 'beginner' | 'easy' | 'normal' | 'hard' | 'unrated';
export type Currency = 'CNY' | 'USD';
export type MatchStatus = 'exact' | 'partial' | 'close' | 'wrong' | 'unknown';
export type Direction = 'higher' | 'lower' | 'equal' | 'near';
export type NumericField = 'price' | 'popularity' | 'reviews' | 'rating' | 'releaseDate';
export interface FieldResult { status: MatchStatus; direction?: Direction }
export interface NumericRule { mode: 'absolute' | 'percent'; exact: number; partial: number; close: number }
export interface Comparison {
  isCorrect: boolean;
  fields: Record<NumericField, FieldResult>;
  matchingTags: string[];
  matchingCompanies: string[];
}

export const LEVELS: readonly Level[];
export const RATED_LEVELS: readonly Level[];
export const CURRENCIES: readonly Currency[];
export const MAX_GUESSES: number;
export const NUMERIC_FIELDS: readonly NumericField[];
export const COMPARISON_RULES: Readonly<{
  price: Readonly<Record<Currency, NumericRule>>;
  popularity: NumericRule;
  reviewsRate: NumericRule;
  releaseDate: Readonly<{ exactYears: number; partialYears: number; closeYears: number }>;
}>;
export function isLevelInPool(level: Level, pool: Level): boolean;
export function isAnswer(game: Game): boolean;
export function answerPool(games: Game[], pool: Level): Game[];
export function getPlayerPeak(game: Game): number | undefined;
export function getRegularPrice(game: Game, currency?: Currency): number | undefined;
export function getPositiveRate(game: Game): number | undefined;
export function numericDistance(user: number, correct: number, mode: NumericRule['mode']): number;
export function statusByDistance(distance: number, rule: NumericRule): MatchStatus;
export function comparisonDirection(user: number, correct: number, status: MatchStatus): Direction;
export function compareNumericValues(user: number | undefined, correct: number | undefined, rule: NumericRule): FieldResult;
export function parseReleaseDate(value: unknown): number;
export function compareDateValues(userDate: string, correctDate: string, thresholds?: { exactYears: number; partialYears: number; closeYears: number }): FieldResult;
export function compareGames(guess: Game, answer: Game, currency?: Currency): Comparison;
export function dailyGame<T extends Game>(games: T[], day: string): T;
