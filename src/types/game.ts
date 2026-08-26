/**
 * Game data types for SteamGuess
 */

export interface GamePrice {
  currency?: string;
  regular: number;
}

export interface GamePriceSet {
  us: GamePrice;
  cn?: Partial<GamePrice>;
}

export interface GamePopularity {
  /** Legacy SteamSpy field: peak concurrent users for the previous day. */
  ccu: number;
  peakYesterday?: number;
  peak7d?: number;
  peak7dSamples?: number;
}

export interface GameReviews {
  total: number;
  positive: number;
  negative: number;
}

export interface GameTags {
  userTags: string[];
  developers: string[];
  publishers: string[];
}

export interface GameHints {
  screenshotUrls?: string[];
  reviewTexts?: string[];
}

export interface GameDifficulty {
  level: 'beginner' | 'easy' | 'normal' | 'hard' | 'hell';
  score: number;
  confidence: number;
  source: 'ai-candidate' | 'editorial-lock' | 'player-feedback' | string;
}

export interface Game {
  appId: number;
  name: string;
  localizedNames?: { zh?: string };
  header_image?: string;
  releaseDate: string; // YYYY-MM-DD
  price: GamePriceSet;
  popularity: GamePopularity;
  reviews: GameReviews;
  tags: GameTags;
  hints?: GameHints;
  /** Present only when this game may be selected as an answer. */
  difficulty?: GameDifficulty;
}

export type ScoredGame = Game & { difficulty: GameDifficulty };
