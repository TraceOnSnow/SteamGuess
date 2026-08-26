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
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS multiplayer_matches (
        id TEXT PRIMARY KEY,
        room_code TEXT NOT NULL,
        difficulty TEXT NOT NULL,
        best_of INTEGER NOT NULL,
        status TEXT NOT NULL,
        winner_player_id TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS multiplayer_match_players (
        match_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        score INTEGER NOT NULL DEFAULT 0,
        outcome TEXT,
        reconnect_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(match_id, player_id),
        FOREIGN KEY(match_id) REFERENCES multiplayer_matches(id),
        FOREIGN KEY(player_id) REFERENCES players(id)
      );
      CREATE TABLE IF NOT EXISTS multiplayer_rounds (
        id TEXT PRIMARY KEY,
        match_id TEXT NOT NULL,
        round_number INTEGER NOT NULL,
        answer_app_id INTEGER NOT NULL,
        winner_player_id TEXT,
        end_reason TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        FOREIGN KEY(match_id) REFERENCES multiplayer_matches(id)
      );
      CREATE TABLE IF NOT EXISTS multiplayer_round_players (
        round_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        guess_count INTEGER NOT NULL,
        guesses_json TEXT NOT NULL,
        PRIMARY KEY(round_id, player_id),
        FOREIGN KEY(round_id) REFERENCES multiplayer_rounds(id),
        FOREIGN KEY(player_id) REFERENCES players(id)
      );
      CREATE INDEX IF NOT EXISTS multiplayer_matches_finished_idx ON multiplayer_matches(finished_at);
      CREATE INDEX IF NOT EXISTS multiplayer_match_players_player_idx ON multiplayer_match_players(player_id, match_id);
      CREATE INDEX IF NOT EXISTS multiplayer_rounds_match_idx ON multiplayer_rounds(match_id, round_number);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS difficulty_feedback_summary (
        app_id INTEGER PRIMARY KEY,
        feedback_count INTEGER NOT NULL DEFAULT 0,
        score_sum REAL NOT NULL DEFAULT 0,
        average_score REAL NOT NULL DEFAULT 0,
        easy_count INTEGER NOT NULL DEFAULT 0,
        normal_count INTEGER NOT NULL DEFAULT 0,
        hard_count INTEGER NOT NULL DEFAULT 0,
        hell_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS difficulty_feedback_summary_score_idx ON difficulty_feedback_summary(average_score);
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE game_sessions
        ADD COLUMN starting_hint_mode TEXT
        CHECK(starting_hint_mode IN ('screenshot', 'review', 'none') OR starting_hint_mode IS NULL);

      ALTER TABLE difficulty_feedback RENAME TO difficulty_feedback_v3;
      DROP INDEX IF EXISTS difficulty_feedback_app_idx;
      CREATE TABLE difficulty_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id TEXT,
        session_id TEXT,
        app_id INTEGER NOT NULL,
        score REAL NOT NULL CHECK(score >= 0 AND score <= 100),
        level TEXT NOT NULL CHECK(level IN ('beginner', 'easy', 'normal', 'hard', 'hell')),
        reason TEXT NOT NULL DEFAULT 'difficulty_unreasonable',
        created_at TEXT NOT NULL,
        FOREIGN KEY(player_id) REFERENCES players(id),
        FOREIGN KEY(session_id) REFERENCES game_sessions(id)
      );
      INSERT INTO difficulty_feedback(
        id, player_id, session_id, app_id, score, level, reason, created_at
      )
      SELECT id, player_id, session_id, app_id, score, level, reason, created_at
      FROM difficulty_feedback_v3;
      DROP TABLE difficulty_feedback_v3;
      CREATE INDEX difficulty_feedback_app_idx
        ON difficulty_feedback(app_id, created_at);
      CREATE INDEX difficulty_feedback_player_app_idx
        ON difficulty_feedback(player_id, app_id, created_at DESC, id DESC);

      ALTER TABLE difficulty_feedback_summary
        ADD COLUMN beginner_count INTEGER NOT NULL DEFAULT 0;
      DELETE FROM difficulty_feedback_summary;
      INSERT INTO difficulty_feedback_summary(
        app_id, feedback_count, score_sum, average_score,
        easy_count, normal_count, hard_count, hell_count, updated_at, beginner_count
      )
      WITH ranked AS (
        SELECT
          feedback.*,
          ROW_NUMBER() OVER (
            PARTITION BY feedback.player_id, feedback.app_id
            ORDER BY feedback.created_at DESC, feedback.id DESC
          ) AS feedback_rank
        FROM difficulty_feedback AS feedback
        JOIN game_sessions AS session ON session.id = feedback.session_id
        WHERE feedback.player_id IS NOT NULL
          AND session.player_id = feedback.player_id
          AND session.answer_app_id = feedback.app_id
          AND session.finished_at IS NOT NULL
          AND session.outcome IN ('won', 'lost', 'surrendered')
      )
      SELECT
        app_id,
        COUNT(*),
        SUM(score),
        AVG(score),
        SUM(level = 'easy'),
        SUM(level = 'normal'),
        SUM(level = 'hard'),
        SUM(level = 'hell'),
        MAX(created_at),
        SUM(level = 'beginner')
      FROM ranked
      WHERE feedback_rank = 1
      GROUP BY app_id;
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
      hints_used, started_at, finished_at, starting_hint_mode
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      outcome = excluded.outcome,
      guesses = excluded.guesses,
      hints_used = excluded.hints_used,
      finished_at = excluded.finished_at,
      starting_hint_mode = excluded.starting_hint_mode
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
    session.startingHintMode ?? 'none',
  );
}

export function getSession(db, sessionId) {
  return db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId) ?? null;
}

function latestFeedbackRows(db, appId) {
  return db.prepare(`
    WITH ranked AS (
      SELECT
        feedback.*,
        ROW_NUMBER() OVER (
          PARTITION BY feedback.player_id, feedback.app_id
          ORDER BY feedback.created_at DESC, feedback.id DESC
        ) AS feedback_rank
      FROM difficulty_feedback AS feedback
      JOIN game_sessions AS session ON session.id = feedback.session_id
      WHERE feedback.app_id = ?
        AND feedback.player_id IS NOT NULL
        AND session.player_id = feedback.player_id
        AND session.answer_app_id = feedback.app_id
        AND session.finished_at IS NOT NULL
        AND session.outcome IN ('won', 'lost', 'surrendered')
    )
    SELECT score, level
    FROM ranked
    WHERE feedback_rank = 1
  `).all(appId);
}

export function refreshDifficultyFeedbackSummary(db, appId, now = new Date().toISOString()) {
  const rows = latestFeedbackRows(db, appId);
  if (rows.length === 0) {
    db.prepare('DELETE FROM difficulty_feedback_summary WHERE app_id = ?').run(appId);
    return null;
  }
  const scoreSum = rows.reduce((total, row) => total + Number(row.score), 0);
  const counts = { beginner: 0, easy: 0, normal: 0, hard: 0, hell: 0 };
  for (const row of rows) counts[row.level] += 1;
  db.prepare(`
    INSERT INTO difficulty_feedback_summary(
      app_id, feedback_count, score_sum, average_score,
      easy_count, normal_count, hard_count, hell_count, updated_at, beginner_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(app_id) DO UPDATE SET
      feedback_count = excluded.feedback_count,
      score_sum = excluded.score_sum,
      average_score = excluded.average_score,
      easy_count = excluded.easy_count,
      normal_count = excluded.normal_count,
      hard_count = excluded.hard_count,
      hell_count = excluded.hell_count,
      updated_at = excluded.updated_at,
      beginner_count = excluded.beginner_count
  `).run(
    appId,
    rows.length,
    scoreSum,
    scoreSum / rows.length,
    counts.easy,
    counts.normal,
    counts.hard,
    counts.hell,
    now,
    counts.beginner,
  );
  return getDifficultyFeedbackSummary(db, appId);
}

export function insertDifficultyFeedback(db, feedback, now = new Date().toISOString()) {
  const session = feedback.sessionId ? getSession(db, feedback.sessionId) : null;
  if (!session || !session.finished_at) throw new Error('Difficulty feedback requires a completed game session.');
  if (session.player_id !== feedback.playerId || Number(session.answer_app_id) !== feedback.appId) {
    throw new Error('Difficulty feedback does not match the completed game session.');
  }
  upsertPlayer(db, feedback.playerId, now);
  const result = db.prepare(`
    INSERT INTO difficulty_feedback(player_id, session_id, app_id, score, level, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    feedback.playerId,
    feedback.sessionId,
    feedback.appId,
    feedback.score,
    feedback.level,
    feedback.reason ?? 'difficulty_unreasonable',
    now,
  );
  refreshDifficultyFeedbackSummary(db, feedback.appId, now);
  return Number(result.lastInsertRowid);
}

export function getDifficultyFeedbackSummary(db, appId) {
  return db.prepare('SELECT * FROM difficulty_feedback_summary WHERE app_id = ?').get(appId) ?? null;
}


export function recordMultiplayerMatch(db, record, now = new Date().toISOString()) {
  db.exec('BEGIN IMMEDIATE;');
  try {
    for (const player of record.players) upsertPlayer(db, player.id, now);
    db.prepare(`
      INSERT INTO multiplayer_matches(id, room_code, difficulty, best_of, status, winner_player_id, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, winner_player_id = excluded.winner_player_id, finished_at = excluded.finished_at
    `).run(record.id, record.roomCode, record.difficulty, record.bestOf, record.status, record.winnerPlayerId ?? null, record.startedAt, record.finishedAt ?? now);
    const playerStatement = db.prepare(`
      INSERT INTO multiplayer_match_players(match_id, player_id, display_name, score, outcome, reconnect_count)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(match_id, player_id) DO UPDATE SET score = excluded.score, outcome = excluded.outcome, reconnect_count = excluded.reconnect_count
    `);
    for (const player of record.players) playerStatement.run(record.id, player.id, player.displayName, player.score ?? 0, player.outcome ?? null, player.reconnectCount ?? 0);
    const roundStatement = db.prepare(`
      INSERT OR REPLACE INTO multiplayer_rounds(id, match_id, round_number, answer_app_id, winner_player_id, end_reason, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const roundPlayerStatement = db.prepare(`
      INSERT OR REPLACE INTO multiplayer_round_players(round_id, player_id, outcome, guess_count, guesses_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const round of record.rounds) {
      roundStatement.run(round.id, record.id, round.roundNumber, round.answerAppId, round.winnerPlayerId ?? null, round.endReason, round.startedAt, round.finishedAt);
      for (const player of round.players) roundPlayerStatement.run(round.id, player.playerId, player.outcome, player.guesses.length, JSON.stringify(player.guesses));
    }
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}
