/**
 * Game Comparison Engine
 * Core logic for comparing guessed games with correct answer
 */

import type { Game } from '../types/game';
import type { ComparisonResult, FieldComparison } from '../types/comparison';
import { comparisonConfig } from '../config/comparison';
import { FieldComparator } from './FieldComparator';

export class ComparisonEngine {
  private config = comparisonConfig;
  private comparator = new FieldComparator();

  compare(guess: Partial<Game>, correctGame: Game): ComparisonResult {
    const result: ComparisonResult = {
      nameMatch: this.compareName(guess, correctGame),
      priceMatch: this.comparePrice(guess, correctGame),
      ccuMatch: this.comparePopularity(guess, correctGame),
      totalReviewsMatch: this.compareTotalReviews(guess, correctGame), // New field comparison
      reviewsRateMatch: this.compareReviews(guess, correctGame),
      releaseMatch: this.compareRelease(guess, correctGame),
      allFieldsMatches: [],
      isCorrect: false,
    };

    result.allFieldsMatches = [
      result.nameMatch,
      result.priceMatch,
      result.ccuMatch,
      result.reviewsRateMatch,
      result.releaseMatch,
    ];

    result.isCorrect = result.nameMatch.status === 'exact';
    return result;
  }

  private compareName(guess: Partial<Game>, correct: Game): FieldComparison {
    return this.comparator.compareExactText('Name', guess.name, correct.name);
  }

  private comparePrice(guess: Partial<Game>, correct: Game): FieldComparison {
    return this.comparator.compareNumeric({
      fieldName: 'Price',
      userValue: guess.price?.us?.current,
      correctValue: correct.price.us.current,
      rule: this.config.rules.price,
      formatter: value => `$${value}`,
    });
  }

  private comparePopularity(guess: Partial<Game>, correct: Game): FieldComparison {
    return this.comparator.compareNumeric({
      fieldName: 'Popularity',
      userValue: guess.popularity?.ccu,
      correctValue: correct.popularity.ccu,
      rule: this.config.rules.popularity,
      formatter: value => String(value),
    });
  }

  private compareTotalReviews(guess: Partial<Game>, correct: Game): FieldComparison {
    return this.comparator.compareNumeric({
      fieldName: 'Total Reviews',
      userValue: guess.reviews?.total,
      correctValue: correct.reviews.total,
      rule: this.config.rules.popularity,
      formatter: value => String(value),
    });
  }

  private compareReviews(guess: Partial<Game>, correct: Game): FieldComparison {
    const userRate = this.getPositiveRate(guess.reviews);
    const correctRate = this.getPositiveRate(correct.reviews);

    return this.comparator.compareNumeric({
      fieldName: 'Reviews',
      userValue: guess.reviews ? userRate : undefined,
      correctValue: correctRate,
      rule: this.config.rules.reviewsRate,
      formatter: value => String(value),
    });
  }

  private compareRelease(guess: Partial<Game>, correct: Game): FieldComparison {
    return this.comparator.compareYear(
      'Release Date',
      guess.releaseDate,
      correct.releaseDate,
      this.config.rules.releaseYear
    );
  }



  private getPositiveRate(reviews: Game['reviews'] | undefined): number {
    if (!reviews || reviews.total <= 0) return 0;
    return Math.round((reviews.positive / reviews.total) * 100);
  }

}
