import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LATEST_SCHEMA_VERSION, openDatabase, insertDifficultyFeedback, getDifficultyFeedbackSummary, upsertSession } from '../database.js';
import { createRateLimiter } from '../api.js';

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
    insertDifficultyFeedback(db, { playerId: 'player_test_124', appId: 10, score: 48, level: 'normal' }, '2026-07-30T00:00:00.000Z');
    assert.deepEqual({ ...getDifficultyFeedbackSummary(db, 10) }, {
      app_id: 10, feedback_count: 2, score_sum: 120, average_score: 60,
      easy_count: 0, normal_count: 1, hard_count: 1, hell_count: 0, updated_at: '2026-07-30T00:00:00.000Z',
    });
    db.close();
  });

  it('keeps feedback when the session completion request was not stored', () => {
    const db = testDb();
    const id = insertDifficultyFeedback(db, {
      playerId: 'player_test_456', sessionId: 'session_missing_456', appId: 20,
      score: 34, level: 'normal', reason: 'difficulty_unreasonable',
    });
    assert.ok(id > 0);
    assert.deepEqual({ ...db.prepare('SELECT session_id, app_id, score, level FROM difficulty_feedback').get() }, {
      session_id: null, app_id: 20, score: 34, level: 'normal',
    });
    db.close();
  });

});

describe('database migrations', () => {
  it('applies migrations once and reports the latest schema version', () => {
    const db = testDb();
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, LATEST_SCHEMA_VERSION);
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
