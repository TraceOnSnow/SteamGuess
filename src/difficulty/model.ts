import type { DifficultyLabel, DifficultyLevel, LabelingGame, RecognitionFeatures } from '../labeler/types';

export const DIFFICULTY_MODEL_STORAGE_KEY = 'steamguess-difficulty-model-v1';
export const DIFFICULTY_LEVELS: DifficultyLevel[] = ['easy', 'normal', 'hard', 'hell'];
export const DIFFICULTY_TARGETS: Record<DifficultyLevel, number> = { easy: 0, normal: 1, hard: 2, hell: 3 };
const FEATURE_NAMES: Array<keyof RecognitionFeatures> = ['owners', 'ccu', 'reviews', 'playtime', 'positiveRatio'];

export interface DifficultyPrediction {
  appId: number;
  score: number;
  level: DifficultyLevel;
  confidence: number;
  source: 'manual' | 'regression' | 'fallback';
  excluded: boolean;
}

export interface DifficultyModel {
  schemaVersion: 1;
  generatedAt: string;
  trainingLabels: number;
  distribution: Record<DifficultyLevel, number>;
  coefficients: number[];
  trainMae: number;
  trainAccuracy: number;
  poolCounts: Record<DifficultyLevel, number>;
  predictions: Record<string, DifficultyPrediction>;
}

function solve(matrix: number[][], vector: number[]): number[] {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-12) throw new Error('回归矩阵不可求解，请增加不同难度的标注');
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    augmented[column] = augmented[column].map(value => value / divisor);
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      augmented[row] = augmented[row].map((value, index) => value - factor * augmented[column][index]);
    }
  }
  return augmented.map(row => row.at(-1) ?? 0);
}

function fit(rows: number[][], targets: number[], ridge = 1): number[] {
  const width = rows[0].length;
  const xtx = Array.from({ length: width }, () => Array<number>(width).fill(0));
  const xty = Array<number>(width).fill(0);
  rows.forEach((row, rowIndex) => {
    row.forEach((value, i) => {
      xty[i] += value * targets[rowIndex];
      row.forEach((other, j) => { xtx[i][j] += value * other; });
    });
  });
  for (let index = 1; index < width; index += 1) xtx[index][index] += ridge;
  return solve(xtx, xty);
}

function featureRow(game: LabelingGame): number[] | null {
  if (!game.recognitionFeatures) return null;
  return [1, ...FEATURE_NAMES.map(name => Number(game.recognitionFeatures?.[name] ?? 0))];
}

function rawPrediction(coefficients: number[], game: LabelingGame): number {
  const row = featureRow(game);
  if (!row) return Math.max(0, Math.min(3, (100 - game.recognitionScore) / 100 * 3));
  return Math.max(0, Math.min(3, row.reduce((sum, value, index) => sum + value * coefficients[index], 0)));
}

export function levelForValue(value: number): DifficultyLevel {
  if (value < 0.5) return 'easy';
  if (value < 1.5) return 'normal';
  if (value < 2.5) return 'hard';
  return 'hell';
}

function predictionConfidence(value: number): number {
  const distance = Math.min(...[0.5, 1.5, 2.5].map(boundary => Math.abs(value - boundary)));
  return Math.round(Math.min(1, distance / 0.5) * 1000) / 1000;
}

export function isLevelInPool(level: DifficultyLevel, pool: DifficultyLevel): boolean {
  return DIFFICULTY_LEVELS.indexOf(level) <= DIFFICULTY_LEVELS.indexOf(pool);
}

export function trainDifficultyModel(
  games: LabelingGame[],
  labels: ReadonlyMap<number, DifficultyLabel>,
  minLabels = 20,
): DifficultyModel | null {
  const byAppId = new Map(games.map(game => [game.appId, game]));
  const training = [...labels.values()].filter(
    (label): label is DifficultyLabel & { level: DifficultyLevel } => !label.excluded && Boolean(label.level) && Boolean(byAppId.get(label.appId)?.recognitionFeatures),
  );
  if (training.length < minLabels) return null;

  const rows = training.map(label => featureRow(byAppId.get(label.appId)!)!);
  const targets = training.map(label => typeof label.score === 'number' ? label.score / 100 * 3 : DIFFICULTY_TARGETS[label.level]);
  const coefficients = fit(rows, targets);
  const distribution = { easy: 0, normal: 0, hard: 0, hell: 0 };
  training.forEach(label => { distribution[label.level] += 1; });

  let absoluteError = 0;
  let correct = 0;
  training.forEach((label, index) => {
    const predicted = Math.max(0, Math.min(3, rows[index].reduce((sum, value, featureIndex) => sum + value * coefficients[featureIndex], 0)));
    absoluteError += Math.abs(predicted - targets[index]);
    if (levelForValue(predicted) === label.level) correct += 1;
  });

  const predictions: Record<string, DifficultyPrediction> = {};
  const poolCounts = { easy: 0, normal: 0, hard: 0, hell: 0 };
  for (const game of games) {
    const label = labels.get(game.appId);
    const excluded = label?.excluded === true || game.appType?.toLocaleLowerCase() === 'application';
    const value = rawPrediction(coefficients, game);
    const manualLevel = label && !label.excluded ? label.level : null;
    const manualValue = label && !label.excluded && typeof label.score === 'number' ? label.score / 100 * 3 : null;
    const level = manualLevel ?? levelForValue(manualValue ?? value);
    const source = manualLevel ? 'manual' : game.recognitionFeatures ? 'regression' : 'fallback';
    predictions[String(game.appId)] = {
      appId: game.appId,
      score: Math.round((manualValue ?? (manualLevel ? DIFFICULTY_TARGETS[manualLevel] : value)) / 3 * 1000) / 10,
      level,
      confidence: manualLevel ? 1 : predictionConfidence(value),
      source,
      excluded,
    };
    if (!excluded) {
      for (const pool of DIFFICULTY_LEVELS) if (isLevelInPool(level, pool)) poolCounts[pool] += 1;
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    trainingLabels: training.length,
    distribution,
    coefficients: coefficients.map(value => Math.round(value * 1_000_000) / 1_000_000),
    trainMae: Math.round(absoluteError / training.length * 1000) / 1000,
    trainAccuracy: Math.round(correct / training.length * 1000) / 1000,
    poolCounts,
    predictions,
  };
}

export function saveDifficultyModel(model: DifficultyModel, storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(DIFFICULTY_MODEL_STORAGE_KEY, JSON.stringify(model));
}

export function loadDifficultyModel(storage: Pick<Storage, 'getItem'> = localStorage): DifficultyModel | null {
  const raw = storage.getItem(DIFFICULTY_MODEL_STORAGE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<DifficultyModel>;
    return value.schemaVersion === 1 && value.predictions ? value as DifficultyModel : null;
  } catch {
    return null;
  }
}
