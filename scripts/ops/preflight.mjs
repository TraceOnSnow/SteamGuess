#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';

const failures = [];
const warnings = [];
const pass = message => console.log(`PASS ${message}`);
const fail = message => failures.push(message);
const warn = message => warnings.push(message);
const configuredActiveLimit = Number.parseInt(process.env.STEAMGUESS_ACTIVE_LIMIT || '1000', 10);
const activeLimit = Number.isSafeInteger(configuredActiveLimit) && configuredActiveLimit > 0
  ? configuredActiveLimit
  : 1000;
const configuredMinimumPlayable = Number.parseInt(process.env.STEAMGUESS_MIN_PLAYABLE_GAMES || '', 10);
const minimumPlayableGames = Number.isSafeInteger(configuredMinimumPlayable) && configuredMinimumPlayable > 0
  ? configuredMinimumPlayable
  : Math.max(1, Math.min(activeLimit, 500));

const nodeMajor = Number(process.versions.node.split('.')[0]);
nodeMajor >= 24 ? pass(`Node ${process.versions.node}`) : fail(`Node 24+ required for node:sqlite; found ${process.versions.node}`);

for (const path of ['dist/index.html', 'public/games_demo.json', 'server/index.js']) {
  existsSync(path) ? pass(`${path} exists`) : fail(`${path} is missing`);
}

if (existsSync('public/games_demo.json')) {
  const raw = JSON.parse(readFileSync('public/games_demo.json', 'utf8'));
  const games = Array.isArray(raw) ? raw : Object.values(raw);
  const appIds = new Set();
  let localized = 0;
  let cnPrices = 0;
  let invalid = 0;
  let playable = 0;
  for (const game of games) {
    if (!Number.isSafeInteger(game.appId) || game.appId <= 0 || appIds.has(game.appId)) invalid += 1;
    appIds.add(game.appId);
    if (game.localizedNames?.zh) localized += 1;
    if (Number.isFinite(game.price?.cn?.regular)) cnPrices += 1;
    if (!Array.isArray(game.tags?.userTags) || game.tags.userTags.length > 20) invalid += 1;
    if (game.difficulty !== undefined) {
      const difficultyValid = ['beginner', 'easy', 'normal', 'hard', 'hell'].includes(game.difficulty?.level)
        && Number.isFinite(game.difficulty?.score)
        && game.difficulty.score >= 0
        && game.difficulty.score <= 100;
      if (difficultyValid) playable += 1;
      else invalid += 1;
    }
  }
  games.length >= minimumPlayableGames
    ? pass(`search catalog has ${games.length} games (minimum ${minimumPlayableGames} for active limit ${activeLimit})`)
    : fail(`search catalog has only ${games.length} games; expected at least ${minimumPlayableGames} for active limit ${activeLimit}`);
  playable > 0 ? pass(`answer pool has ${playable} scored games`) : fail('answer pool is empty');
  invalid === 0 ? pass('search catalog shape, AppIDs, and optional difficulty') : fail(`${invalid} catalog records are invalid`);
  localized / games.length >= .95 ? pass(`Chinese names ${localized}/${games.length}`) : warn(`Chinese names only ${localized}/${games.length}`);
  cnPrices / games.length >= .75 ? pass(`CN regular prices ${cnPrices}/${games.length}`) : warn(`CN regular prices only ${cnPrices}/${games.length}`);
}

if (process.env.VITE_LABELER_ENABLED === 'true') warn('VITE_LABELER_ENABLED=true exposes the internal difficulty manager in this build');
else pass('internal difficulty manager disabled by default');
if (process.env.STEAM_WEB_API_KEY) pass('Steam Web API key configured');
else warn('STEAM_WEB_API_KEY is empty; profile import will be unavailable');

for (const message of warnings) console.warn(`WARN ${message}`);
for (const message of failures) console.error(`FAIL ${message}`);
if (failures.length) process.exit(1);
console.log(`READY checks=${7 + (existsSync('public/games_demo.json') ? 5 : 0)} warnings=${warnings.length}`);
