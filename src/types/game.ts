import type { Level } from '../../shared/game-rules.js';

export interface GamePrice { regular: number | null }

/** One record of the published snapshot (public/games_demo.json). */
export interface Game {
  appId: number;
  /** English store name. */
  name: string;
  localizedNames?: { zh?: string };
  aliases?: string[];
  header_image?: string;
  /** YYYY-MM-DD, or '' when unknown. */
  releaseDate: string;
  /** Regular (undiscounted) price per region; null when not sold there. */
  price: { us: GamePrice; cn: GamePrice };
  popularity: { ccu: number; peakYesterday?: number; peak7d?: number };
  reviews: { total: number; positive: number; negative: number };
  tags: { userTags: string[]; developers: string[]; publishers: string[] };
  /** Metacritic score from the Steam store page, when it lists one. */
  metacritic?: number | null;
  /** Years of The Game Awards ceremonies that nominated it for Game of the Year. */
  tga?: number[];
  /** Present only on answers. */
  hints?: { screenshotUrls: string[] };
  difficulty?: { level: Level };
}
