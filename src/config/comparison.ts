import type { ComparisonConfig, ColorThreshold } from '../types/comparison';

export const comparisonConfig: ComparisonConfig = {
  priceThreshold: 10,                  // ±$10 = exact
  popularityThresholdPercent: 20,      // ±20% = exact
  ratingThresholdPercent: 5,           // ±5% = exact
  yearThreshold: 0,                    // 0 = exact year match
  tagOverlapPercent: 75,               // 75%+ = exact
};

export const colorThreshold: ColorThreshold = {
  exact: '#4CAF50',    // Green
  partial: '#FFC107',  // Yellow
  close: '#FF9800',    // Orange
  wrong: '#F44336',    // Red
  unknown: '#9E9E9E',  // Gray
};

export function getStatusColor(status: string): string {
  switch (status) {
    case 'exact':
      return colorThreshold.exact;
    case 'partial':
      return colorThreshold.partial;
    case 'close':
      return colorThreshold.close;
    case 'wrong':
      return colorThreshold.wrong;
    case 'unknown':
      return colorThreshold.unknown;
    default:
      return colorThreshold.unknown;
  }
}
