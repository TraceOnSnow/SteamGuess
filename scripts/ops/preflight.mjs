#!/usr/bin/env node
// Release gate: the build exists and the published data matches the edition.
import { existsSync, readFileSync } from 'node:fs';

const failures = [];
const check = (ok, message) => { if (ok) console.log(`PASS ${message}`); else failures.push(message); };
const json = path => JSON.parse(readFileSync(path, 'utf8'));

check(Number(process.versions.node.split('.')[0]) >= 24, `Node ${process.versions.node} (24+ required for node:sqlite)`);
for (const path of ['dist/index.html', 'public/games_demo.json', 'data/curated/answers.json', 'server/index.js']) check(existsSync(path), `${path} exists`);

if (!failures.length) {
  const edition = json('shared/edition.json');
  const games = Object.values(json('public/games_demo.json'));
  const listed = json('data/curated/answers.json').games;
  const answers = games.filter(game => game.difficulty);
  const ids = new Set(games.map(game => game.appId));

  check(ids.size === games.length && games.every(game => Number.isSafeInteger(game.appId) && game.appId > 0), 'AppIDs are valid and unique');
  check(games.length >= 1500 && games.length <= edition.searchLimit, `search catalog has ${games.length} games (1500–${edition.searchLimit})`);
  check(answers.length === edition.answerLimit, `answer list has ${answers.length} games (expected ${edition.answerLimit})`);
  check(listed.length === answers.length && listed.every(entry => games.find(game => game.appId === entry.appId)?.difficulty?.level === entry.level),
    'published tiers match data/curated/answers.json');
  for (const level of edition.levels) {
    const size = answers.filter(game => edition.levels.indexOf(game.difficulty.level) <= edition.levels.indexOf(level)).length;
    check(size === edition.rankCaps[level], `${level} pool has ${size} games (expected ${edition.rankCaps[level]})`);
  }
  check(games.every(game => /^\d{4}-\d{2}-\d{2}$/.test(game.releaseDate) && game.tags?.userTags?.length > 0 && game.reviews?.total > 0),
    'every game has a release date, tags and reviews');
  check(answers.every(game => game.hints?.screenshotUrls?.length > 0), 'every answer has a screenshot');
  check(games.every(game => game.difficulty || !game.hints), 'search-only games carry no hints');
  const priced = currency => games.filter(game => Number.isFinite(game.price?.[currency]?.regular)).length;
  console.log(`INFO prices known: CNY ${priced('cn')}/${games.length}, USD ${priced('us')}/${games.length}`);
}

for (const message of failures) console.error(`FAIL ${message}`);
if (failures.length) process.exit(1);
console.log('READY');
