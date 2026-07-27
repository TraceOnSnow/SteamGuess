import type { Game } from './game';

/** Comparison result types used by the game engine and UI. */

export type MatchStatus = 'exact' | 'partial' | 'close' | 'wrong' | 'unknown';
export type NumericCompareMode = 'absolute' | 'percent';
export type ComparisonDirection = 'higher' | 'lower' | 'equal' | 'near';
export type ComparisonValue = string | number | null;

export interface FieldComparison {
  fieldName: string;
  userValue: ComparisonValue;
  correctValue: ComparisonValue;
  status: MatchStatus;
  direction?: ComparisonDirection;
}

export interface ComparisonResult {
  nameMatch: FieldComparison;
  priceMatch: FieldComparison;
  ccuMatch: FieldComparison;
  totalReviewsMatch: FieldComparison;
  reviewsRateMatch: FieldComparison;
  releaseMatch: FieldComparison;
  allFieldsMatches: FieldComparison[];
  isCorrect: boolean;
}

export interface GuessRecord {
  game: Game;
  result: ComparisonResult;
}

export interface ComparisonConfig {
  rules: {
    price: NumericRuleConfig;
    popularity: NumericRuleConfig;
    reviewsRate: NumericRuleConfig;
    releaseDate: {
      exactYears: number;
      partialYears: number;
      closeYears: number;
    };
  };
}

export interface NumericRuleConfig {
  mode: NumericCompareMode;
  exact: number;
  partial: number;
  close: number;
}
