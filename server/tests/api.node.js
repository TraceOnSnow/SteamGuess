import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_SCHEMA_VERSION, openDatabase, saveAnswerFeedback, upsertSession } from '../database.js';
import { createApiHandler, createRateLimiter, testHelpers } from '../api.js';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'steamguess-api-'));
  roots.push(root);
  return root;
}

function session(overrides = {}) {
  return {
    id: 'session_abcdefgh', playerId: 'player_abcdefgh', mode: 'practice', difficulty: 'unrated', answerAppId: 10,
    outcome: 'won', guesses: 4, hintsUsed: 1, startedAt: '2026-11-10T00:00:00Z', finishedAt: '2026-11-10T00:01:00Z', ...overrides,
  };
}

function invoker(handler) {
  return (method, url, payload, address = 'test') => new Promise(resolve => {
    const chunks = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))];
    const request = Object.assign((async function* () { for (const chunk of chunks) yield chunk; })(), {
      method, url, headers: {}, socket: { remoteAddress: address },
    });
    const response = { setHeader() {}, end(body) { resolve({ status: this.statusCode, body: JSON.parse(body) }); } };
    handler(request, response);
  });
}

describe('runtime database', () => {
  it('migrates a fresh database to the latest schema', () => {
    const db = openDatabase(join(tempRoot(), 'runtime.sqlite'));
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, LATEST_SCHEMA_VERSION);
    db.close();
  });

  it('stores one verdict per finished session and lets a second tap replace it', () => {
    const db = openDatabase(join(tempRoot(), 'runtime.sqlite'));
    upsertSession(db, session());
    saveAnswerFeedback(db, { sessionId: 'session_abcdefgh', playerId: 'player_abcdefgh', appId: 10, verdict: 'fair' });
    saveAnswerFeedback(db, { sessionId: 'session_abcdefgh', playerId: 'player_abcdefgh', appId: 10, verdict: 'obscure' });
    assert.deepEqual(db.prepare('SELECT app_id, verdict FROM answer_feedback').all().map(row => ({ ...row })), [{ app_id: 10, verdict: 'obscure' }]);
    db.close();
  });

  it('rejects verdicts for unfinished sessions or the wrong game', () => {
    const db = openDatabase(join(tempRoot(), 'runtime.sqlite'));
    assert.throws(() => saveAnswerFeedback(db, { sessionId: 'session_missing1', playerId: 'player_abcdefgh', appId: 10, verdict: 'fair' }), /completed game session/);
    upsertSession(db, session());
    assert.throws(() => saveAnswerFeedback(db, { sessionId: 'session_abcdefgh', playerId: 'player_abcdefgh', appId: 11, verdict: 'fair' }), /does not match/);
    assert.throws(() => saveAnswerFeedback(db, { sessionId: 'session_abcdefgh', playerId: 'player_someone1', appId: 10, verdict: 'fair' }), /does not match/);
    db.close();
  });
});

describe('HTTP API', () => {
  it('serves the published snapshot as the catalog', async () => {
    const root = tempRoot();
    mkdirSync(join(root, 'public'));
    writeFileSync(join(root, 'public/games_demo.json'), JSON.stringify({ 10: { appId: 10, name: 'Ten' } }));
    const handler = createApiHandler({ rootDir: root, dbPath: join(root, 'runtime.sqlite') });
    const response = await invoker(handler)('GET', '/api/catalog/games');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, [{ appId: 10, name: 'Ten' }]);
    handler.close();
  });

  it('records a finished round, then accepts a verdict for it', async () => {
    const root = tempRoot();
    const dbPath = join(root, 'runtime.sqlite');
    const handler = createApiHandler({ rootDir: root, dbPath });
    const invoke = invoker(handler);
    const body = { sessionId: 'session_abcdefgh', playerId: 'player_abcdefgh', mode: 'daily', difficulty: 'hard', answerAppId: 10, outcome: 'lost', guesses: 10, hintsUsed: 2, startedAt: '2026-11-10T00:00:00Z' };
    assert.equal((await invoke('POST', '/api/feedback/answer', { sessionId: body.sessionId, playerId: body.playerId, appId: 10, verdict: 'fair' })).status, 409);
    assert.equal((await invoke('POST', '/api/sessions/complete', body)).status, 201);
    assert.equal((await invoke('POST', '/api/sessions/complete', { ...body, difficulty: 'hell' })).status, 400);
    assert.equal((await invoke('POST', '/api/sessions/complete', { ...body, mode: 'library' })).status, 400);
    assert.equal((await invoke('POST', '/api/feedback/answer', { sessionId: body.sessionId, playerId: body.playerId, appId: 10, verdict: 'boring' })).status, 400);
    assert.equal((await invoke('POST', '/api/feedback/answer', { sessionId: body.sessionId, playerId: body.playerId, appId: 10, verdict: 'obscure' })).status, 201);
    assert.equal((await invoke('GET', '/api/admin/difficulties')).status, 404);
    handler.close();
    const db = openDatabase(dbPath);
    assert.deepEqual({ ...db.prepare('SELECT mode, difficulty, outcome, guesses, hints_used FROM game_sessions').get() }, { mode: 'daily', difficulty: 'hard', outcome: 'lost', guesses: 10, hints_used: 2 });
    assert.equal(db.prepare('SELECT verdict FROM answer_feedback').get().verdict, 'obscure');
    db.close();
  });

  it('rate-limits writes per client address', async () => {
    const root = tempRoot();
    const handler = createApiHandler({ rootDir: root, dbPath: join(root, 'runtime.sqlite'), writeRateLimit: 1 });
    const invoke = invoker(handler);
    assert.equal((await invoke('POST', '/api/sessions/complete', {})).status, 400);
    assert.equal((await invoke('POST', '/api/sessions/complete', {})).status, 429);
    assert.equal((await invoke('POST', '/api/sessions/complete', {}, 'other')).status, 400);
    handler.close();
  });
});

describe('rate limiter', () => {
  it('blocks requests over the fixed-window limit and resets later', () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 1_000 });
    assert.equal(limiter.consume('player', 10_000).allowed, true);
    assert.equal(limiter.consume('player', 10_100).allowed, true);
    assert.equal(limiter.consume('player', 10_200).allowed, false);
    assert.equal(limiter.consume('player', 11_001).allowed, true);
  });
  it('only trusts X-Forwarded-For behind a proxy', () => {
    const request = { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, socket: { remoteAddress: '9.9.9.9' } };
    assert.equal(testHelpers.clientAddress(request, true), '1.2.3.4');
    assert.equal(testHelpers.clientAddress(request, false), '9.9.9.9');
  });
});
