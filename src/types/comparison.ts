/**
 * Comparison result types
 */

export type MatchStatus = 'exact' | 'partial' | 'close' | 'wrong' | 'unknown';

export type NumericCompareMode = 'absolute' | 'percent';

export interface FieldComparison {
  fieldName: string;
  userValue: any;
  correctValue: any;
  status: MatchStatus;
  display?: string; // Custom display text
}

export interface ComparisonResult {
  // Basic fields
  nameMatch: FieldComparison;
  priceMatch: FieldComparison;
  ccuMatch: FieldComparison;
  totalReviewsMatch: FieldComparison;
  reviewsRateMatch: FieldComparison;
  releaseMatch: FieldComparison;

  // Meta
  allFieldsMatches: FieldComparison[];
  isCorrect: boolean;
}

export interface ComparisonConfig {
  rules: {
    price: {
      mode: NumericCompareMode;
      exact: number;
      partial: number;
      close: number;
    };
    popularity: {
      mode: NumericCompareMode;
      exact: number;
      partial: number;
      close: number;
    };
    reviewsRate: {
      mode: NumericCompareMode;
      exact: number;
      partial: number;
      close: number;
    };
    releaseYear: {
      exact: number;
      partial: number;
      close: number;
    };
  };
}

