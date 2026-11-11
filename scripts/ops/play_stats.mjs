#!/usr/bin/env node
// Per-answer results from the runtime database: the raw material for moving
// games between tiers or out of the list. Read-only.
//   node scripts/ops/play_stats.mjs [--db path] [--min 5] [--level unrated]
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const dbPath = resolve(argument('--db', process.env.STEAMGUESS_DB_PATH || 'data/runtime/steamguess.sqlite'));
const minimum = Number(argument('--min', '5'));
const onlyLevel = argument('--level', '');
if (!existsSync(dbPath)) { console.error(`Database not found: ${dbPath}`); process.exit(1); }

const answers = new Map(JSON.parse(readFileSync('data/curated/answers.json', 'utf8')).games.map(entry => [entry.appId, entry]));
const db = new DatabaseSync(dbPath, { readOnly: true });
const hasVerdicts = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'answer_feedback'").get();
const rows = db.prepare(`
  SELECT s.answer_app_id AS appId, COUNT(*) AS rounds, SUM(s.outcome = 'won') AS won,
         AVG(CASE WHEN s.outcome = 'won' THEN s.guesses END) AS avgGuesses
  FROM game_sessions s WHERE s.finished_at IS NOT NULL GROUP BY s.answer_app_id
`).all();
const verdicts = new Map((hasVerdicts ? db.prepare(`
  SELECT app_id AS appId, SUM(verdict = 'fair') AS fair, SUM(verdict = 'obscure') AS obscure FROM answer_feedback GROUP BY app_id
`).all() : []).map(row => [row.appId, row]));
db.close();

const table = rows
  .map(row => ({ ...row, entry: answers.get(row.appId), verdict: verdicts.get(row.appId) }))
  .filter(row => row.rounds >= minimum && (!onlyLevel || row.entry?.level === onlyLevel))
  .sort((a, b) => a.won / a.rounds - b.won / b.rounds)
  .map(row => ({
    appId: row.appId, name: row.entry?.nameZh || row.entry?.name || '(not an answer now)', level: row.entry?.level ?? '-',
    rounds: row.rounds, solved: `${Math.round(row.won / row.rounds * 100)}%`,
    avgGuesses: row.avgGuesses ? Number(row.avgGuesses.toFixed(1)) : '-',
    fair: row.verdict?.fair ?? 0, obscure: row.verdict?.obscure ?? 0,
  }));
console.log(`${rows.reduce((sum, row) => sum + row.rounds, 0)} finished rounds over ${rows.length} answers; showing ${table.length} with at least ${minimum} rounds, hardest first.`);
if (table.length) console.table(table);
