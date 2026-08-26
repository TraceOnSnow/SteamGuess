import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const DIFFICULTY_LEVELS = ['beginner', 'easy', 'normal', 'hard', 'hell'];

export function loadCatalog(rootDir) {
  const candidates = [resolve(rootDir, 'dist/games_demo.json'), resolve(rootDir, 'public/games_demo.json')];
  const file = candidates.find(existsSync);
  if (!file) throw new Error('Multiplayer catalog not found: build the application first.');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  return Object.values(raw).filter(game =>
    Number.isInteger(game?.appId)
    && typeof game.name === 'string'
  );
}

export function difficultyPool(catalog, difficulty) {
  const max = DIFFICULTY_LEVELS.indexOf(difficulty);
  return catalog.filter(game => {
    if (!DIFFICULTY_LEVELS.includes(game.difficulty?.level)) return false;
    if (!Number.isFinite(game.difficulty?.score) || game.difficulty.score < 0 || game.difficulty.score > 100) return false;
    return DIFFICULTY_LEVELS.indexOf(game.difficulty.level) <= max;
  });
}
