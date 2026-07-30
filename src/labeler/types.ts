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

export interface RecognitionFeatures {
  owners: number;
  ccu: number;
  reviews: number;
  playtime: number;
  positiveRatio: number;
}

export interface LabelingGame {
  appId: number;
  name: string;
  localizedNames?: { zh?: string };
  appType?: string | null;
  developers: string[];
  publishers: string[];
  userTags: string[];
  headerImage?: string | null;
  screenshotUrl?: string | null;
  metrics: LabelingMetrics;
  recognitionScore: number;
  recognitionFeatures?: RecognitionFeatures;
  suggestedLevel: DifficultyLevel;
}

export interface DifficultyLabel {
  appId: number;
  level: DifficultyLevel | null;
  score?: number;
  excluded: boolean;
  reviewedAt: string;
  automatic?: boolean;
  excludedReason?: 'manual' | 'software';
}

export interface LabelingCatalog {
  schemaVersion: number;
  generatedAt: string;
  sourceCatalog: string;
  games: LabelingGame[];
}
