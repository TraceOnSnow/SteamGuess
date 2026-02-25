/**
 * Game data types for SteamGuess
 */

export interface GamePrice {
  currency?: string;
  current: number;
}

export interface GamePriceSet {
  us: GamePrice;
  cn?: Partial<GamePrice>;
}

export interface GamePopularity {
  ccu: number;
  owners: number;
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
  screenshotUrl?: string;
  funnyReview?: string;
}

export interface Game {
  appId: number;
  name: string;
  header_image?: string;
  releaseDate: string; // YYYY-MM-DD
  price: GamePriceSet;
  popularity: GamePopularity;
  reviews: GameReviews;
  tags: GameTags;
  hints?: GameHints;
}

export type PlayerGuess = Partial<Game>;
