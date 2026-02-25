/**
 * Game Comparison Engine
 * Core logic for comparing guessed games with correct answer
 */

import type { Game, PlayerGuess } from '../types/game';
import type { ComparisonResult, FieldComparison, MatchStatus } from '../types/comparison';
import { comparisonConfig } from '../config/comparison';

export class ComparisonEngine {
  private config = comparisonConfig;

  compare(guess: PlayerGuess, correctGame: Game): ComparisonResult {
    const result: ComparisonResult = {
      nameMatch: this.compareName(guess, correctGame),
      priceMatch: this.comparePrice(guess, correctGame),
      popularityMatch: this.comparePopularity(guess, correctGame),
      reviewsMatch: this.compareReviews(guess, correctGame),
      releaseMatch: this.compareRelease(guess, correctGame),
      tagsMatch: this.compareTags(guess, correctGame),
      allFieldsMatches: [],
      isCorrect: false,
    };

    result.allFieldsMatches = [
      result.nameMatch,
      result.priceMatch,
      result.popularityMatch,
      result.reviewsMatch,
      result.releaseMatch,
      result.tagsMatch,
    ];

    result.isCorrect = result.nameMatch.status === 'exact';
    return result;
  }

  private compareName(guess: PlayerGuess, correct: Game): FieldComparison {
    const userValue = guess.name;
    const correctValue = correct.name;

    let status: MatchStatus = 'unknown';
    if (!userValue) {
      status = 'unknown';
    } else if (userValue.toLowerCase() === correctValue.toLowerCase()) {
      status = 'exact';
    } else {
      status = 'wrong';
    }

    return {
      fieldName: 'Name',
      userValue,
      correctValue,
      status,
    };
  }

  private comparePrice(guess: PlayerGuess, correct: Game): FieldComparison {
    const userPrice = guess.price?.us?.current;
    const correctPrice = correct.price.us.current;

    const userValue = userPrice !== undefined ? `$${userPrice}` : null;
    const correctValue = `$${correctPrice}`;

    let status: MatchStatus = 'unknown';
    if (userPrice === undefined) {
      status = 'unknown';
    } else {
      const diff = Math.abs(userPrice - correctPrice);

      if (diff <= this.config.priceThreshold) {
        status = 'exact';
      } else if (diff <= this.config.priceThreshold * 2) {
        status = 'partial';
      } else if (diff <= this.config.priceThreshold * 4) {
        status = 'close';
      } else {
        status = 'wrong';
      }
    }

    return {
      fieldName: 'Price',
      userValue,
      correctValue,
      status,
      display: this.getPriceArrow(userPrice, correctPrice),
    };
  }

  private comparePopularity(guess: PlayerGuess, correct: Game): FieldComparison {
    const userCcu = guess.popularity?.ccu;
    const userOwners = guess.popularity?.owners;

    const userValue = userCcu !== undefined && userOwners !== undefined
      ? `${userCcu} (owners: ${userOwners})`
      : null;
    const correctValue = `${correct.popularity.ccu} (owners: ${correct.popularity.owners})`;

    let status: MatchStatus = 'unknown';
    if (userCcu === undefined || userOwners === undefined) {
      status = 'unknown';
    } else {
      const ccuDiffPercent = this.percentDifference(userCcu, correct.popularity.ccu);
      const ownersDiffPercent = this.percentDifference(userOwners, correct.popularity.owners);

      if (ccuDiffPercent <= 20 && ownersDiffPercent <= 20) {
        status = 'exact';
      } else if (ccuDiffPercent <= 50 && ownersDiffPercent <= 50) {
        status = 'partial';
      } else if (ccuDiffPercent <= 100 || ownersDiffPercent <= 100) {
        status = 'close';
      } else {
        status = 'wrong';
      }
    }

    return {
      fieldName: 'Popularity',
      userValue,
      correctValue,
      status,
      display: this.getPopularityArrow(userCcu, correct.popularity.ccu),
    };
  }

  private compareReviews(guess: PlayerGuess, correct: Game): FieldComparison {
    const userRate = this.getPositiveRate(guess.reviews);
    const correctRate = this.getPositiveRate(correct.reviews);

    const userValue = guess.reviews
      ? `${guess.reviews.total} reviews, ${userRate}% positive`
      : null;
    const correctValue = `${correct.reviews.total} reviews, ${correctRate}% positive`;

    let status: MatchStatus = 'unknown';
    if (!guess.reviews || !userValue) {
      status = 'unknown';
    } else {
      const rateDiff = Math.abs(userRate - correctRate);
      if (rateDiff <= 5) {
        status = 'exact';
      } else if (rateDiff <= 15) {
        status = 'partial';
      } else if (rateDiff <= 30) {
        status = 'close';
      } else {
        status = 'wrong';
      }
    }

    return {
      fieldName: 'Reviews',
      userValue,
      correctValue,
      status,
      display: this.getReviewArrow(userRate, correctRate),
    };
  }

  private compareRelease(guess: PlayerGuess, correct: Game): FieldComparison {
    const userValue = guess.releaseDate;
    const correctValue = correct.releaseDate;

    let status: MatchStatus = 'unknown';
    if (!userValue) {
      status = 'unknown';
    } else {
      const userYear = parseInt(userValue.split('-')[0]);
      const correctYear = parseInt(correctValue.split('-')[0]);
      const yearDiff = Math.abs(userYear - correctYear);

      if (yearDiff === 0) {
        status = 'exact';
      } else if (yearDiff === 1) {
        status = 'partial';
      } else if (yearDiff <= 3) {
        status = 'close';
      } else {
        status = 'wrong';
      }
    }

    return {
      fieldName: 'Release Date',
      userValue,
      correctValue,
      status,
      display: this.getYearArrow(userValue, correctValue),
    };
  }

  private compareTags(guess: PlayerGuess, correct: Game): FieldComparison {
    const userValue = guess.tags ? this.tagsToString(guess.tags) : null;
    const correctValue = this.tagsToString(correct.tags);

    let status: MatchStatus = 'unknown';
    if (!guess.tags || !userValue) {
      status = 'unknown';
    } else {
      const overlapPercent = this.calculateTagOverlap(guess.tags, correct.tags);

      if (overlapPercent >= 75) {
        status = 'exact';
      } else if (overlapPercent >= 50) {
        status = 'partial';
      } else if (overlapPercent >= 25) {
        status = 'close';
      } else {
        status = 'wrong';
      }
    }

    return {
      fieldName: 'Tags',
      userValue,
      correctValue,
      status,
    };
  }

  private getPositiveRate(reviews: Game['reviews'] | undefined): number {
    if (!reviews || reviews.total <= 0) return 0;
    return Math.round((reviews.positive / reviews.total) * 100);
  }

  private percentDifference(a: number, b: number): number {
    if (b === 0) return a === 0 ? 0 : 100;
    return Math.abs((a - b) / b) * 100;
  }

  private calculateTagOverlap(userTags: Game['tags'], correctTags: Game['tags']): number {
    const userSet = new Set([
      ...userTags.userTags,
      ...userTags.developers,
      ...userTags.publishers,
    ]);

    const correctSet = new Set([
      ...correctTags.userTags,
      ...correctTags.developers,
      ...correctTags.publishers,
    ]);

    const intersection = [...userSet].filter(tag => correctSet.has(tag)).length;
    const union = new Set([...userSet, ...correctSet]).size;

    return union === 0 ? 0 : (intersection / union) * 100;
  }

  private tagsToString(tags: Game['tags']): string {
    return [
      ...tags.developers,
      ...tags.publishers,
      ...tags.userTags,
    ]
      .filter(t => t && t.length > 0)
      .join(', ');
  }

  private getPriceArrow(userPrice: number | undefined, correctPrice: number): string | undefined {
    if (userPrice === undefined) return undefined;
    if (Math.abs(userPrice - correctPrice) <= this.config.priceThreshold) return '≈';
    return userPrice > correctPrice ? '↑' : '↓';
  }

  private getPopularityArrow(userPop: number | undefined, correctPop: number): string | undefined {
    if (userPop === undefined) return undefined;
    if (Math.abs(userPop - correctPop) <= correctPop * 0.2) return '≈';
    return userPop > correctPop ? '↑' : '↓';
  }

  private getReviewArrow(userRate: number | undefined, correctRate: number): string | undefined {
    if (userRate === undefined) return undefined;
    const diff = Math.abs(userRate - correctRate);
    if (diff <= 5) return '≈';
    return userRate > correctRate ? '↑' : '↓';
  }

  private getYearArrow(userDate: string | undefined, correctDate: string): string | undefined {
    if (!userDate) return undefined;
    const userYear = parseInt(userDate.split('-')[0]);
    const correctYear = parseInt(correctDate.split('-')[0]);
    if (userYear === correctYear) return '≈';
    return userYear > correctYear ? '↑' : '↓';
  }
}
