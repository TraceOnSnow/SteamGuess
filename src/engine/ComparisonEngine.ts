import type { Game } from '../types/game';
import type { ComparisonResult, FieldComparison } from '../types/comparison';
import { comparisonConfig } from '../config/comparison';
import { getPlayerPeak, getRegularPrice } from '../../shared/game-rules.js';
export { getPlayerPeak, getRegularPrice } from '../../shared/game-rules.js';
import { FieldComparator } from './FieldComparator';

const numberFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const priceFormatter = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function formatRegularPrice(game: Game): string {
  const price = getRegularPrice(game);
  return price === undefined ? '—' : priceFormatter.format(price);
}

export class ComparisonEngine {
  private readonly comparator = new FieldComparator();

  compare(guess: Game, correctGame: Game): ComparisonResult {
    const nameMatch: FieldComparison = {
      fieldName: 'Name',
      userValue: guess.name,
      correctValue: correctGame.name,
      status: guess.appId === correctGame.appId ? 'exact' : 'wrong',
    };

    const result: ComparisonResult = {
      nameMatch,
      priceMatch: this.comparator.compareNumeric({
        fieldName: 'Price',
        userValue: getRegularPrice(guess),
        correctValue: getRegularPrice(correctGame),
        rule: comparisonConfig.rules.price,
        formatter: value => priceFormatter.format(value),
      }),
      ccuMatch: this.comparator.compareNumeric({
        fieldName: 'Popularity',
        userValue: getPlayerPeak(guess),
        correctValue: getPlayerPeak(correctGame),
        rule: comparisonConfig.rules.popularity,
        formatter: value => numberFormatter.format(value),
      }),
      totalReviewsMatch: this.comparator.compareNumeric({
        fieldName: 'Total Reviews',
        userValue: guess.reviews.total,
        correctValue: correctGame.reviews.total,
        rule: comparisonConfig.rules.popularity,
        formatter: value => numberFormatter.format(value),
      }),
      reviewsRateMatch: this.comparator.compareNumeric({
        fieldName: 'Reviews Rate',
        userValue: this.getPositiveRate(guess),
        correctValue: this.getPositiveRate(correctGame),
        rule: comparisonConfig.rules.reviewsRate,
        formatter: value => `${value.toFixed(1)}%`,
      }),
      releaseMatch: this.comparator.compareDate(
        'Release Date',
        guess.releaseDate,
        correctGame.releaseDate,
        comparisonConfig.rules.releaseDate,
      ),
      allFieldsMatches: [],
      isCorrect: guess.appId === correctGame.appId,
    };

    result.allFieldsMatches = [
      result.nameMatch,
      result.priceMatch,
      result.ccuMatch,
      result.totalReviewsMatch,
      result.reviewsRateMatch,
      result.releaseMatch,
    ];

    return result;
  }

  private getPositiveRate(game: Game): number {
    if (game.reviews.total <= 0) return 0;
    return (game.reviews.positive / game.reviews.total) * 100;
  }
}
