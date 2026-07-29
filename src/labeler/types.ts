export type DifficultyLevel = 'easy' | 'normal' | 'hard' | 'hell';

export interface LabelingMetrics {
  ccu: number;
  ownersMin: number;
  ownersMax: number;
  positive: number;
  negative: number;
  reviewsTotal: number;
  averageForeverMinutes: number;
  averageTwoWeeksMinutes: number;
}

export interface LabelingGame {
  appId: number;
  name: string;
  developers: string[];
  publishers: string[];
  userTags: string[];
  headerImage?: string | null;
  screenshotUrl?: string | null;
  metrics: LabelingMetrics;
  recognitionScore: number;
  suggestedLevel: DifficultyLevel;
}

export interface DifficultyLabel {
  appId: number;
  level: DifficultyLevel | null;
  excluded: boolean;
  reviewedAt: string;
}

export interface LabelingCatalog {
  schemaVersion: number;
  generatedAt: string;
  sourceCatalog: string;
  games: LabelingGame[];
}
