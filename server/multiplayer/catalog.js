import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RATED_LEVELS, answerPool } from '../../shared/game-rules.js';

export function loadCatalog(rootDir) {
  const candidates = [resolve(rootDir, 'public/games_demo.json'), resolve(rootDir, 'dist/games_demo.json')];
  const file = candidates.find(existsSync);
  if (!file) throw new Error('Multiplayer catalog not found: build the application first.');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  return Object.values(raw).filter(game => Number.isInteger(game?.appId) && typeof game.name === 'string');
}

/** Rooms only draw from rated tiers; the unverified long tail is single-player only. */
export function difficultyPool(catalog, difficulty) {
  return RATED_LEVELS.includes(difficulty) ? answerPool(catalog, difficulty) : [];
}
