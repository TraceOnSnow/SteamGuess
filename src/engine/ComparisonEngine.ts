/**
 * Game Comparison Engine
 * Core logic for comparing guessed games with correct answer
 */

import type { Game, PlayerGuess } from '../types/game';
import type { ComparisonResult, FieldComparison, MatchStatus } from '../types/comparison';
import { comparisonConfig } from '../config/comparison';

export class ComparisonEngine {
  private config = comparisonConfig;

  /**
   * Main comparison method
   * Compares a guessed game against the correct answer game
   */
  compare(guess: PlayerGuess, correctGame: Game): ComparisonResult {
    const result: ComparisonResult = {
      nameMatch: this.compareName(guess, correctGame),
      playerMatch: this.comparePlayers(guess, correctGame),
      priceMatch: this.comparePrice(guess, correctGame),
      popularityMatch: this.comparePopularity(guess, correctGame),
      reviewsMatch: this.compareReviews(guess, correctGame),
      releaseMatch: this.compareRelease(guess, correctGame),
      tagsMatch: this.compareTags(guess, correctGame),
      allFieldsMatches: [],
      isCorrect: false,
    };

    // Build allFieldsMatches array
    result.allFieldsMatches = [
      result.nameMatch,
      result.playerMatch,
      result.priceMatch,
      result.popularityMatch,
      result.reviewsMatch,
      result.releaseMatch,
      result.tagsMatch,
    ];

    // Check if answer is correct (name must match)
    result.isCorrect = result.nameMatch.status === 'exact';

    return result;
  }

  /**
   * Compare game name
   */
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

  /**
   * Compare player types (Single, Multi, Online)
   */
  private comparePlayers(guess: PlayerGuess, correct: Game): FieldComparison {
    const userValue = guess.players ? this.playersToString(guess.players) : null;
    const correctValue = this.playersToString(correct.players);

    let status: MatchStatus = 'unknown';
    if (!userValue) {
      status = 'unknown';
    } else {
      const userFlags = this.extractPlayerFlags(guess.players!);
      const correctFlags = this.extractPlayerFlags(correct.players);

      if (JSON.stringify(userFlags) === JSON.stringify(correctFlags)) {
        status = 'exact';
      } else if (this.hasPlayerIntersection(userFlags, correctFlags)) {
        status = 'partial';
      } else {
        status = 'wrong';
      }
    }

    return {
      fieldName: 'Players',
      userValue,
      correctValue,
      status,
    };
  }

  /**
   * Compare price (current and historical low)
   */
  private comparePrice(guess: PlayerGuess, correct: Game): FieldComparison {
    const userValue = guess.price ? `$${guess.price.current} (low: $${guess.price.historicalLow})` : null;
    const correctValue = `$${correct.price.current} (low: $${correct.price.historicalLow})`;

    let status: MatchStatus = 'unknown';
    if (!userValue || !guess.price) {
      status = 'unknown';
    } else {
      const currentDiff = Math.abs(guess.price.current - correct.price.current);
      const lowDiff = Math.abs(guess.price.historicalLow - correct.price.historicalLow);

      // Both within threshold = exact
      if (currentDiff <= this.config.priceThreshold && lowDiff <= this.config.priceThreshold) {
        status = 'exact';
      }
      // At least one within threshold = partial
      else if (currentDiff <= this.config.priceThreshold || lowDiff <= this.config.priceThreshold) {
        status = 'partial';
      }
      // Current price within 2x threshold = close
      else if (currentDiff <= this.config.priceThreshold * 2) {
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
      display: this.getPriceArrow(guess.price?.current, correct.price.current),
    };
  }

  /**
   * Compare popularity (current weekly and peak)
   */
  private comparePopularity(guess: PlayerGuess, correct: Game): FieldComparison {
    const userValue = guess.popularity
      ? `${guess.popularity.currentWeekly} (peak: ${guess.popularity.peakConcurrent})`
      : null;
    const correctValue = `${correct.popularity.currentWeekly} (peak: ${correct.popularity.peakConcurrent})`;

    let status: MatchStatus = 'unknown';
    if (!userValue || !guess.popularity) {
      status = 'unknown';
    } else {
      // Calculate percentage difference
      const currentDiffPercent = this.percentDifference(guess.popularity.currentWeekly, correct.popularity.currentWeekly);
      const peakDiffPercent = this.percentDifference(guess.popularity.peakConcurrent, correct.popularity.peakConcurrent);

      if (currentDiffPercent <= 20 && peakDiffPercent <= 20) {
        status = 'exact';
      } else if (currentDiffPercent <= 50 && peakDiffPercent <= 50) {
        status = 'partial';
      } else if (currentDiffPercent <= 100 || peakDiffPercent <= 100) {
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
      display: this.getPopularityArrow(guess.popularity?.currentWeekly, correct.popularity.currentWeekly),
    };
  }

  /**
   * Compare reviews (count and positive percent)
   */
  private compareReviews(guess: PlayerGuess, correct: Game): FieldComparison {
    const userValue = guess.reviews
      ? `${guess.reviews.count} reviews, ${guess.reviews.positivePercent}% positive`
      : null;
    const correctValue = `${correct.reviews.count} reviews, ${correct.reviews.positivePercent}% positive`;

    let status: MatchStatus = 'unknown';
    if (!userValue || !guess.reviews) {
      status = 'unknown';
    } else {
      const rateDiff = Math.abs(guess.reviews.positivePercent - correct.reviews.positivePercent);

      // Both good = exact
      if (rateDiff <= 5) {
        status = 'exact';
      }
      // Rate close enough = partial
      else if (rateDiff <= 15) {
        status = 'partial';
      }
      // Rate somewhat close = close
      else if (rateDiff <= 30) {
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
      display: this.getReviewArrow(guess.reviews?.positivePercent, correct.reviews.positivePercent),
    };
  }

  /**
   * Compare release date
   */
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

  /**
   * Compare tags (user tags + genres + developer + publisher)
   */
  private compareTags(guess: PlayerGuess, correct: Game): FieldComparison {
    const userValue = guess.tags ? this.tagsToString(guess.tags) : null;
    const correctValue = this.tagsToString(correct.tags);

    let status: MatchStatus = 'unknown';
    if (!userValue || !guess.tags) {
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

  // ============ Helper Methods ============

  private playersToString(players: Game['players']): string {
    const parts: string[] = [];
    if (players.singlePlayer) parts.push('Single-player');
    if (players.multiplayer) parts.push('Multi-player');
    if (players.online) parts.push('Online');
    return parts.join(', ') || 'None';
  }

  private extractPlayerFlags(players: Game['players']): boolean[] {
    return [players.singlePlayer, players.multiplayer, players.online];
  }

  private hasPlayerIntersection(a: boolean[], b: boolean[]): boolean {
    return a.some((val, i) => val && b[i]);
  }

  private percentDifference(a: number, b: number): number {
    if (b === 0) return a === 0 ? 0 : 100;
    return Math.abs((a - b) / b) * 100;
  }

  private calculateTagOverlap(userTags: Game['tags'], correctTags: Game['tags']): number {
    const userSet = new Set([
      ...userTags.userTags,
      ...userTags.genres,
      userTags.developer,
      userTags.publisher,
    ]);

    const correctSet = new Set([
      ...correctTags.userTags,
      ...correctTags.genres,
      correctTags.developer,
      correctTags.publisher,
    ]);

    const intersection = [...userSet].filter(tag => correctSet.has(tag)).length;
    const union = new Set([...userSet, ...correctSet]).size;

    return union === 0 ? 0 : (intersection / union) * 100;
  }

  private tagsToString(tags: Game['tags']): string {
    return [
      tags.developer,
      tags.publisher,
      ...tags.userTags,
      ...tags.genres,
    ]
      .filter(t => t && t.length > 0)
      .join(', ');
  }

  // Arrow display helpers
  private getPriceArrow(userPrice: number | undefined, correctPrice: number): string | undefined {
    if (!userPrice) return undefined;
    if (Math.abs(userPrice - correctPrice) <= this.config.priceThreshold) return '≈';
    return userPrice > correctPrice ? '↑' : '↓';
  }

  private getPopularityArrow(userPop: number | undefined, correctPop: number): string | undefined {
    if (!userPop) return undefined;
    if (Math.abs(userPop - correctPop) <= correctPop * 0.2) return '≈';
    return userPop > correctPop ? '↑' : '↓';
  }

  private getReviewArrow(userRate: number | undefined, correctRate: number): string | undefined {
    if (!userRate) return undefined;
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
