/**
 * Game data types for SteamGuess
 */

export interface GamePrice {
  current: number;
  historicalLow: number;
}

export interface GamePopularity {
  currentWeekly: number;
  peakConcurrent: number;
}

export interface GameReviews {
  count: number;
  positivePercent: number; // 0-100
  steamRating: 'Overwhelmingly Positive' | 'Very Positive' | 'Positive' | 'Mixed' | 'Negative' | 'Overwhelmingly Negative';
}

export interface GameTags {
  userTags: string[];
  genres: string[];
  developer: string;
  publisher: string;
}

export interface GamePlayers {
  singlePlayer: boolean;
  multiplayer: boolean;
  online: boolean;
}

export interface GameHints {
  screenshotUrl?: string;
  funnyReview?: string;
}

export interface Game {
  appId: number;
  name: string;
  releaseDate: string; // YYYY-MM-DD
  price: GamePrice;
  popularity: GamePopularity;
  reviews: GameReviews;
  players: GamePlayers;
  tags: GameTags;
  hints?: GameHints;
}

export type PlayerGuess = Partial<Game>;
