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
    releaseYear: {
      exact: 0.2,
      partial: 1,
      close: 3,
    },
  },
};
