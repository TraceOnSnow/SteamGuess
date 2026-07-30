#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dbPath = resolve(process.env.STEAMGUESS_DB_PATH || process.argv[2] || 'data/runtime/steamguess.sqlite');
if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}
const catalogRaw = JSON.parse(readFileSync('public/games_demo.json', 'utf8'));
const catalog = new Map(Object.values(catalogRaw).map(game => [Number(game.appId), game.localizedNames?.zh || game.name]));
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM players) AS players,
      (SELECT COUNT(*) FROM game_sessions) AS sessions,
      (SELECT COUNT(*) FROM difficulty_feedback) AS feedback,
      (SELECT COUNT(*) FROM game_sessions WHERE finished_at >= datetime('now', '-7 days')) AS sessions_7d,
      (SELECT COUNT(*) FROM difficulty_feedback WHERE created_at >= datetime('now', '-7 days')) AS feedback_7d
  `).get();
  console.log('SteamGuess feedback summary');
  console.table([{ ...totals }]);

  const outcomes = db.prepare(`
    SELECT outcome, COUNT(*) AS sessions, ROUND(AVG(guesses), 2) AS avg_guesses,
      ROUND(AVG(hints_used), 2) AS avg_hints
    FROM game_sessions GROUP BY outcome ORDER BY sessions DESC
  `).all().map(row => ({ ...row }));
  if (outcomes.length) {
    console.log('\nOutcomes');
    console.table(outcomes);
  }

  const games = db.prepare(`
    SELECT app_id, COUNT(*) AS feedback, ROUND(AVG(score), 1) AS avg_score,
      MIN(score) AS min_score, MAX(score) AS max_score
    FROM difficulty_feedback
    GROUP BY app_id ORDER BY feedback DESC, app_id LIMIT 30
  `).all().map(row => ({ name: catalog.get(Number(row.app_id)) || `App ${row.app_id}`, ...row }));
  if (games.length) {
    console.log('\nMost-reviewed difficulties');
    console.table(games);
  }
} finally {
  db.close();
}
