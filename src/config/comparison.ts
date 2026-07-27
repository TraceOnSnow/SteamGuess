import type { ComparisonConfig } from '../types/comparison';

export const comparisonConfig: ComparisonConfig = {
  rules: {
    price: {
      mode: 'absolute',
      exact: 1,
      partial: 5,
      close: 15,
    },
    popularity: {
      mode: 'percent',
      exact: 5,
      partial: 50,
      close: 100,
    },
    reviewsRate: {
      mode: 'absolute',
      exact: 1,
      partial: 5,
      close: 10,
    },
    releaseDate: {
      exactYears: 0.2,
      partialYears: 1,
      closeYears: 3,
    },
  },
};
