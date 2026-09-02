import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { LATEST_SCHEMA_VERSION, openDatabase, insertDifficultyFeedback, getDifficultyFeedbackSummary, upsertSession } from '../database.js';
import { createApiHandler, createRateLimiter } from '../api.js';

const paths = [];
afterEach(() => {
  for (const path of paths.splice(0)) {
    for (const suffix of ['', '-shm', '-wal']) rmSync(path + suffix, { force: true });
  }
});

function testDb() {
  const path = join(tmpdir(), `steamguess-${randomUUID()}.sqlite`);
  paths.push(path);
  return openDatabase(path);
}

function createCatalogFixture() {
  const path = join(tmpdir(), `steamguess-catalog-${randomUUID()}.sqlite`);
  paths.push(path);
  const seed = new DatabaseSync(path);
  seed.exec(`
    CREATE TABLE games (
      appid INTEGER PRIMARY KEY,
      name_en TEXT NOT NULL,
      name_zh TEXT,
      pool_status TEXT NOT NULL DEFAULT 'eligible',
      status_reason TEXT,
      difficulty_score INTEGER,
      difficulty_tier TEXT,
      difficulty_manual_score INTEGER,
      difficulty_locked INTEGER NOT NULL DEFAULT 0,
      difficulty_source TEXT,
      player_feedback_count INTEGER NOT NULL DEFAULT 0,
      player_feedback_mean REAL,
      player_feedback_stddev REAL,
      player_feedback_updated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      developers_json TEXT NOT NULL DEFAULT '[]',
      publishers_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT NOT NULL DEFAULT '[]',
      cover_url TEXT,
      heat_rank INTEGER
    );
  `);
  seed.close();
  return path;
}

describe('feedback database', () => {
  it('stores sessions and difficulty feedback for an anonymous player', () => {
    const db = testDb();
    upsertSession(db, {
      id: 'session_test_123', playerId: 'player_test_123', mode: 'difficulty', difficulty: 'normal',
      answerAppId: 10, outcome: 'won', guesses: 3, hintsUsed: 1,
      startedAt: '2026-07-30T00:00:00Z', finishedAt: '2026-07-30T00:01:00Z',
    });
    const id = insertDifficultyFeedback(db, {
      playerId: 'player_test_123', sessionId: 'session_test_123', appId: 10,
      score: 72, level: 'hard', reason: 'difficulty_unreasonable',
    });
    assert.ok(id > 0);
    assert.deepEqual({ ...db.prepare('SELECT app_id, score, level FROM difficulty_feedback').get() }, {
      app_id: 10, score: 72, level: 'hard',
    });
    upsertSession(db, {
      id: 'session_test_124', playerId: 'player_test_124', mode: 'difficulty', difficulty: 'normal',
      answerAppId: 10, outcome: 'lost', guesses: 10, hintsUsed: 0, startingHintMode: 'review',
      startedAt: '2026-07-30T00:00:00Z', finishedAt: '2026-07-30T00:02:00Z',
    });
    insertDifficultyFeedback(db, {
      playerId: 'player_test_124', sessionId: 'session_test_124', appId: 10, score: 48, level: 'normal',
    }, '2026-07-30T00:02:00.000Z');
    assert.deepEqual({ ...getDifficultyFeedbackSummary(db, 10) }, {
      app_id: 10, feedback_count: 2, score_sum: 120, average_score: 60,
      easy_count: 0, normal_count: 1, hard_count: 1, hell_count: 0,
      updated_at: '2026-07-30T00:02:00.000Z', beginner_count: 0,
    });
    db.close();
  });

  it('rejects feedback when the completed session is missing', () => {
    const db = testDb();
    assert.throws(() => insertDifficultyFeedback(db, {
      playerId: 'player_test_456', sessionId: 'session_missing_456', appId: 20,
      score: 34, level: 'normal',
    }), /completed game session/);
    db.close();
  });

});

describe('database migrations', () => {
  it('applies migrations once and reports the latest schema version', () => {
    const db = testDb();
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, LATEST_SCHEMA_VERSION);
    db.close();
  });

  it('migrates v3 feedback data, adds opening hints, and rebuilds latest-player summaries', () => {
    const path = join(tmpdir(), `steamguess-v3-${randomUUID()}.sqlite`);
    paths.push(path);
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, 'old'), (2, 'old'), (3, 'old');
      CREATE TABLE players (
        id TEXT PRIMARY KEY,
        steam_id TEXT UNIQUE,
        display_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE game_sessions (
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
      CREATE TABLE difficulty_feedback (
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
      CREATE INDEX difficulty_feedback_app_idx ON difficulty_feedback(app_id, created_at);
      CREATE TABLE difficulty_feedback_summary (
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
      INSERT INTO players VALUES
        ('player-a', NULL, NULL, 'old', 'old'),
        ('player-b', NULL, NULL, 'old', 'old');
      INSERT INTO game_sessions VALUES
        ('session-a1', 'player-a', 'difficulty', 'normal', 10, 'won', 2, 0, '2026-08-01T00:00:00Z', '2026-08-01T00:01:00Z'),
        ('session-a2', 'player-a', 'difficulty', 'normal', 10, 'lost', 10, 1, '2026-08-02T00:00:00Z', '2026-08-02T00:02:00Z'),
        ('session-b1', 'player-b', 'difficulty', 'normal', 10, 'won', 4, 0, '2026-08-03T00:00:00Z', '2026-08-03T00:01:00Z');
      INSERT INTO difficulty_feedback(
        player_id, session_id, app_id, score, level, created_at
      ) VALUES
        ('player-a', 'session-a1', 10, 30, 'normal', '2026-08-01T00:02:00Z'),
        ('player-a', 'session-a2', 10, 80, 'hard', '2026-08-02T00:03:00Z'),
        ('player-b', 'session-b1', 10, 20, 'easy', '2026-08-03T00:02:00Z');
      INSERT INTO difficulty_feedback_summary VALUES (10, 99, 999, 99, 0, 0, 0, 99, 'stale');
    `);
    legacy.close();

    const db = openDatabase(path);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM difficulty_feedback').get().count, 3);
    assert.deepEqual({ ...getDifficultyFeedbackSummary(db, 10) }, {
      app_id: 10,
      feedback_count: 2,
      score_sum: 100,
      average_score: 50,
      easy_count: 1,
      normal_count: 0,
      hard_count: 1,
      hell_count: 0,
      updated_at: '2026-08-03T00:02:00Z',
      beginner_count: 0,
    });
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('game_sessions') WHERE name='starting_hint_mode'").get().count,
      1,
    );
    upsertSession(db, {
      id: 'session-c1',
      playerId: 'player-c',
      mode: 'difficulty',
      difficulty: 'beginner',
      answerAppId: 10,
      outcome: 'won',
      guesses: 1,
      hintsUsed: 0,
      startingHintMode: 'screenshot',
      startedAt: '2026-08-04T00:00:00Z',
      finishedAt: '2026-08-04T00:01:00Z',
    });
    insertDifficultyFeedback(db, {
      playerId: 'player-c',
      sessionId: 'session-c1',
      appId: 10,
      score: 10,
      level: 'beginner',
    }, '2026-08-04T00:02:00Z');
    assert.equal(getDifficultyFeedbackSummary(db, 10).beginner_count, 1);
    assert.equal(db.prepare("SELECT starting_hint_mode FROM game_sessions WHERE id='session-c1'").get().starting_hint_mode, 'screenshot');
    db.close();
  });
});

describe('rate limiter', () => {
  it('blocks requests over the configured fixed-window limit and resets later', () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 1_000 });
    assert.equal(limiter.consume('player', 10_000).allowed, true);
    assert.equal(limiter.consume('player', 10_100).allowed, true);
    assert.equal(limiter.consume('player', 10_200).allowed, false);
    assert.equal(limiter.consume('player', 11_001).allowed, true);
  });
});

describe('catalog difficulty overrides', () => {
  it('reads and writes the converged games row', async () => {
    const path = createCatalogFixture();
    const {
      listDifficulties,
      openCatalogDatabase,
      setCatalogExclusion,
      upsertDifficultyOverride,
    } = await import('../catalog-difficulty.js');
    const db = openCatalogDatabase(path);
    db.exec(`
      INSERT INTO games(appid, name_en, name_zh, pool_status, difficulty_score,
        difficulty_tier, created_at, updated_at)
      VALUES (10, 'Test Game', '测试游戏', 'eligible', 25, 'normal',
        '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z');
    `);
    let row = upsertDifficultyOverride(db, 10, { manualScore: 80, locked: false }, '2026-08-12T00:00:00Z');
    assert.equal(row.manualScore, 80);
    assert.equal(row.effectiveScore, 80);
    assert.equal(row.effectiveSource, 'manual');
    row = upsertDifficultyOverride(db, 10, { locked: true }, '2026-08-12T00:01:00Z');
    assert.equal(row.effectiveScore, 80);
    assert.equal(row.effectiveLevel, 'hell');
    const listed = listDifficulties(db, { scope: 'active' });
    assert.equal(listed.total, 1);
    assert.equal(listed.rows[0].localizedName, '测试游戏');
    row = setCatalogExclusion(db, 10, { excluded: true, reason: 'too_obscure' }, '2026-08-12T00:02:00Z');
    assert.equal(row.excluded, false);
    assert.equal(row.searchOnly, true);
    assert.equal(row.exclusionReason, 'too_obscure');
    assert.equal(row.active, true);
    assert.equal(listDifficulties(db, { scope: 'active' }).total, 1);
    row = setCatalogExclusion(db, 10, { excluded: true, reason: 'software' }, '2026-08-12T00:02:30Z');
    assert.equal(row.excluded, true);
    assert.equal(row.exclusionReason, 'software');
    assert.equal(row.active, false);
    assert.equal(listDifficulties(db, { scope: 'active' }).total, 0);
    assert.equal(listDifficulties(db, { scope: 'all', filter: 'excluded' }).total, 1);
    row = setCatalogExclusion(db, 10, { excluded: false }, '2026-08-12T00:03:00Z');
    assert.equal(row.excluded, false);
    db.close();
  });
});


describe('difficulty admin HTTP persistence', () => {
  it('writes an override through PUT and reads it back through GET', async () => {
    const path = createCatalogFixture();
    const { openCatalogDatabase } = await import('../catalog-difficulty.js');
    const seed = openCatalogDatabase(path);
    seed.exec(`
      INSERT INTO games(appid, name_en, pool_status, difficulty_score,
        difficulty_tier, created_at, updated_at)
      VALUES (10, 'Test Game', 'eligible', 25, 'normal',
        '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z');
    `);
    seed.close();
    const handler = createApiHandler({ catalogDbPath: path, adminToken: 'secret' });
    const invoke = (method, url, payload) => new Promise(resolve => {
      const chunks = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))];
      const request = Object.assign((async function* () { for (const chunk of chunks) yield chunk; })(), {
        method, url, headers: { authorization: 'Bearer secret' }, socket: { remoteAddress: 'test' },
      });
      const response = {
        setHeader() {},
        end(body) { resolve({ status: this.statusCode, body: JSON.parse(body) }); },
      };
      handler(request, response);
    });

    const saved = await invoke('PUT', '/api/admin/difficulties/10', { manualScore: 83, locked: true });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.manualScore, 83);
    assert.equal(saved.body.effectiveScore, 83);
    const listed = await invoke('GET', '/api/admin/difficulties?scope=active');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.rows[0].manualScore, 83);
    assert.equal(listed.body.rows[0].locked, true);
    const excluded = await invoke('PUT', '/api/admin/difficulties/10', { excluded: true, exclusionReason: 'software' });
    assert.equal(excluded.status, 200);
    assert.equal(excluded.body.excluded, true);
    assert.equal(excluded.body.active, false);
    const active = await invoke('GET', '/api/admin/difficulties?scope=active');
    assert.equal(active.status, 200);
    assert.equal(active.body.total, 0);
    handler.close();

    const verify = openCatalogDatabase(path);
    assert.deepEqual({ ...verify.prepare('SELECT difficulty_manual_score, difficulty_locked, difficulty_score FROM games WHERE appid = 10').get() }, {
      difficulty_manual_score: 83, difficulty_locked: 1, difficulty_score: null,
    });
    assert.deepEqual({ ...verify.prepare('SELECT pool_status, status_reason FROM games WHERE appid = 10').get() }, {
      pool_status: 'excluded',
      status_reason: 'software',
    });
    verify.close();
  });
});
