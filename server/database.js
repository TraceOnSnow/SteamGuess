import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        steam_id TEXT UNIQUE,
        display_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS game_sessions (
        id TEXT PRIMARY KEY,
        player_id TEXT,
        mode TEXT NOT NULL,
        difficulty TEXT,
        answer_app_id INTEGER NOT NULL,
        outcome TEXT,
        guesses INTEGER NOT NULL DEFAULT 0,
        hints_used INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        FOREIGN KEY(player_id) REFERENCES players(id)
      );
      CREATE INDEX IF NOT EXISTS game_sessions_player_idx ON game_sessions(player_id, finished_at);
      CREATE INDEX IF NOT EXISTS game_sessions_answer_idx ON game_sessions(answer_app_id, finished_at);
      CREATE TABLE IF NOT EXISTS difficulty_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id TEXT,
        session_id TEXT,
        app_id INTEGER NOT NULL,
        score REAL NOT NULL CHECK(score >= 0 AND score <= 100),
        level TEXT NOT NULL CHECK(level IN ('easy', 'normal', 'hard', 'hell')),
        reason TEXT NOT NULL DEFAULT 'difficulty_unreasonable',
        created_at TEXT NOT NULL,
        FOREIGN KEY(player_id) REFERENCES players(id),
        FOREIGN KEY(session_id) REFERENCES game_sessions(id)
      );
      CREATE INDEX IF NOT EXISTS difficulty_feedback_app_idx ON difficulty_feedback(app_id, created_at);
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const current = Number(db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version);
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(`Database schema ${current} is newer than this server supports (${LATEST_SCHEMA_VERSION}).`);
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
        .run(migration.version, new Date().toISOString());
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
  }
}

export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function upsertPlayer(db, playerId, now = new Date().toISOString()) {
  db.prepare(`
    INSERT INTO players(id, created_at, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
  `).run(playerId, now, now);
}

export function upsertSession(db, session, now = new Date().toISOString()) {
  upsertPlayer(db, session.playerId, now);
  db.prepare(`
    INSERT INTO game_sessions(
      id, player_id, mode, difficulty, answer_app_id, outcome, guesses,
      hints_used, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      outcome = excluded.outcome,
      guesses = excluded.guesses,
      hints_used = excluded.hints_used,
      finished_at = excluded.finished_at
  `).run(
    session.id,
    session.playerId,
    session.mode,
    session.difficulty ?? null,
    session.answerAppId,
    session.outcome ?? null,
    session.guesses ?? 0,
    session.hintsUsed ?? 0,
    session.startedAt,
    session.finishedAt ?? null,
  );
}

export function insertDifficultyFeedback(db, feedback, now = new Date().toISOString()) {
  upsertPlayer(db, feedback.playerId, now);
  const sessionId = feedback.sessionId && db.prepare('SELECT 1 FROM game_sessions WHERE id = ?').get(feedback.sessionId)
    ? feedback.sessionId
    : null;
  const result = db.prepare(`
    INSERT INTO difficulty_feedback(player_id, session_id, app_id, score, level, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    feedback.playerId,
    sessionId,
    feedback.appId,
    feedback.score,
    feedback.level,
    feedback.reason ?? 'difficulty_unreasonable',
    now,
  );
  return Number(result.lastInsertRowid);
}
