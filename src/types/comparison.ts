/**
 * Comparison result types
 */

export type MatchStatus = 'exact' | 'partial' | 'close' | 'wrong' | 'unknown';

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
  popularityMatch: FieldComparison;
  reviewsMatch: FieldComparison;
  releaseMatch: FieldComparison;
  tagsMatch: FieldComparison;

  // Meta
  allFieldsMatches: FieldComparison[];
  isCorrect: boolean;
}

export interface ComparisonConfig {
  priceThreshold: number; // USD, e.g., 10
  popularityThresholdPercent: number; // e.g., 50
  ratingThresholdPercent: number; // e.g., 5
  yearThreshold: number; // e.g., 1
  tagOverlapPercent: number; // e.g., 50 for "exact", 20 for "partial"
}

export interface ColorThreshold {
  exact: string; // CSS color, e.g., '#4CAF50' (green)
  partial: string; // e.g., '#FFC107' (yellow)
  close: string; // e.g., '#FF9800' (orange)
  wrong: string; // e.g., '#F44336' (red)
  unknown: string; // e.g., '#9E9E9E' (gray)
}
