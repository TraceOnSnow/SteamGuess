import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const DIFFICULTY_LEVELS = ['easy', 'normal', 'hard', 'hell'];

export function loadCatalog(rootDir) {
  const candidates = [resolve(rootDir, 'dist/games_demo.json'), resolve(rootDir, 'public/games_demo.json')];
  const file = candidates.find(existsSync);
  if (!file) throw new Error('Multiplayer catalog not found: build the application first.');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const labelFile = [resolve(rootDir, 'dist/labeling_catalog.json'), resolve(rootDir, 'public/labeling_catalog.json')].find(existsSync);
  const labels = labelFile ? JSON.parse(readFileSync(labelFile, 'utf8')).games ?? [] : [];
  const metadata = new Map(labels.map(game => [game.appId, game]));
  return Object.values(raw).filter(game => Number.isInteger(game?.appId) && typeof game.name === 'string').map(game => {
    const label = metadata.get(game.appId);
    return label ? { ...game, difficulty: { level: label.suggestedLevel, score: Math.round((100 - label.recognitionScore) * 10) / 10, confidence: 0, source: 'fallback' } } : game;
  });
}

export function difficultyPool(catalog, difficulty) {
  const max = DIFFICULTY_LEVELS.indexOf(difficulty);
  return catalog.filter(game => {
    const level = game.difficulty?.level;
    return !level || DIFFICULTY_LEVELS.indexOf(level) <= max;
  });
}
