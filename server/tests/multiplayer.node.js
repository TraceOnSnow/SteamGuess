import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { io as createClient } from 'socket.io-client';
import { createMultiplayerServer } from '../multiplayer/index.js';
import { openDatabase } from '../database.js';

const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });

const testCatalog = [10, 30].map((appId, index) => ({
  appId,
  name: `Test Game ${appId}`,
  localizedNames: { zh: `测试游戏 ${appId}` },
  releaseDate: `202${index}-01-01`,
  price: { us: { currency: 'USD', regular: index + 1 }, cn: { currency: 'CNY', regular: (index + 1) * 10 } },
  popularity: { current: 100 + index, peak: 1000 + index },
  reviews: { total: 100 + index, positive: 90 + index, negative: 10 },
  tags: { developers: [`Test Dev ${appId}`], publishers: [`Test Pub ${appId}`], userTags: [`Test Tag ${appId}`] },
}));
function emit(socket, event, payload) { return new Promise(resolve => socket.emit(event, payload, resolve)); }
async function fixture(options = {}) {
  const http = createServer((_, response) => response.end('ok'));
  const dbPath = join(tmpdir(), `steamguess-mp-${randomUUID()}.sqlite`);
  const multiplayer = createMultiplayerServer(http, { rootDir: process.cwd(), dbPath, catalog: testCatalog, random: () => 0, countdownMs: 5, nextRoundDelayMs: 5, disconnectGraceMs: 15, ...options });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address();
  const connect = () => createClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true });
  cleanup.push(async () => { await multiplayer.close(); await new Promise(resolve => http.close(resolve)); for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true }); });
  return { connect, dbPath };
}
function waitFor(socket, event) { return new Promise(resolve => socket.once(event, resolve)); }
function waitForWhere(socket, event, predicate) { return new Promise(resolve => { const listener = value => { if (!predicate(value)) return; socket.off(event, listener); resolve(value); }; socket.on(event, listener); }); }

describe('multiplayer server', () => {
  it('runs a server-authoritative 1v1 round without leaking the answer', async () => {
    const { connect, dbPath } = await fixture(); const a = connect(); let b = connect(); cleanup.push(async () => { a.close(); b.close(); });
    await Promise.all([waitFor(a, 'connect'), waitFor(b, 'connect')]);
    const created = await emit(a, 'room:create', { playerId: 'player_test_alpha_123', displayName: 'A', settings: { difficulty: 'normal', bestOf: 1, roundTimeSeconds: 120, visibleFields: ['price'] }, commandId: 'command_create_a' });
    assert.equal(created.ok, true); assert.equal('answerAppId' in created.data.room, false);
    const room = created.data.room;
    const joined = await emit(b, 'room:join', { playerId: 'player_test_bravo_456', roomCode: room.code, displayName: 'B', commandId: 'command_join_b' }); assert.equal(joined.ok, true);
    b.close(); b = connect(); await waitFor(b, 'connect');
    const resumed = await emit(b, 'room:resume', { roomCode: room.code, playerId: joined.data.playerId, resumeToken: joined.data.resumeToken });
    assert.equal(resumed.ok, true); assert.equal(resumed.data.room.players.find(player => player.id === joined.data.playerId).connected, true);
    const nonHostStart = await emit(b, 'match:start', { roomId: room.id, commandId: 'command_start_b' }); assert.equal(nonHostStart.ok, false); assert.equal(nonHostStart.error.code, 'NOT_HOST');
    await emit(a, 'lobby:set-ready', { roomId: room.id, ready: true, commandId: 'command_ready_a' });
    await emit(b, 'lobby:set-ready', { roomId: room.id, ready: true, commandId: 'command_ready_b' });
    const countdownPromise = waitForWhere(a, 'room:snapshot', value => value.status === 'countdown');
    const snapshotPromise = waitForWhere(a, 'room:snapshot', value => value.status === 'playing');
    const started = await emit(a, 'match:start', { roomId: room.id, commandId: 'command_start_a' }); assert.equal(started.ok, true);
    const countdown = await countdownPromise; assert.equal(countdown.activeRound, null); assert.ok(countdown.countdownEndsAt);
    const snapshot = await snapshotPromise;
    assert.equal(snapshot.status, 'playing'); assert.ok(snapshot.activeRound.id); assert.equal(JSON.stringify(snapshot).includes('answerAppId'), false);
    const endedPromise = waitFor(a, 'round:ended');
    const guessed = await emit(a, 'round:guess', { roomId: room.id, roundId: snapshot.activeRound.id, guessAppId: 10, commandId: 'command_guess_exact_a' });
    assert.equal(guessed.ok, true); assert.equal(guessed.data.feedback.isCorrect, true); assert.deepEqual(guessed.data.feedback.fields.map(field => field.fieldName), ['price']); assert.deepEqual(guessed.data.feedback.matchingTags, []); assert.equal(JSON.stringify(guessed).includes('correctValue'), false);
    const ended = await endedPromise; assert.equal(ended.answer.appId, 10); assert.equal(ended.winnerPlayerId, created.data.playerId);
    const stored = openDatabase(dbPath); assert.equal(stored.prepare('SELECT COUNT(*) AS count FROM multiplayer_matches').get().count, 1); stored.close();
    const replay = await emit(a, 'round:guess', { roomId: room.id, roundId: snapshot.activeRound.id, guessAppId: 10, commandId: 'command_guess_exact_a' });
    assert.deepEqual(replay, guessed);
    const lobbyPromise = waitForWhere(a, 'room:snapshot', value => value.status === 'lobby');
    const rematchA = await emit(a, 'match:rematch', { roomId: room.id, accept: true, commandId: 'command_rematch_a' }); assert.equal(rematchA.ok, true);
    const rematchB = await emit(b, 'match:rematch', { roomId: room.id, accept: true, commandId: 'command_rematch_b' }); assert.equal(rematchB.ok, true);
    const lobby = await lobbyPromise; assert.equal(lobby.match, null); assert.ok(lobby.players.every(player => !player.ready));
  });

  it('supports a three-player room and enforces its capacity', async () => {
    const { connect } = await fixture();
    const a = connect(); const b = connect(); const c = connect(); const d = connect();
    cleanup.push(async () => { a.close(); b.close(); c.close(); d.close(); });
    await Promise.all([waitFor(a, 'connect'), waitFor(b, 'connect'), waitFor(c, 'connect'), waitFor(d, 'connect')]);
    const created = await emit(a, 'room:create', { playerId: 'player_multi_alpha_123', displayName: 'A', settings: { difficulty: 'normal', bestOf: 1, maxPlayers: 3, roundTimeSeconds: 120, visibleFields: ['price'] }, commandId: 'command_multi_create' });
    assert.equal(created.ok, true); const room = created.data.room; assert.equal(room.settings.maxPlayers, 3);
    const joinedB = await emit(b, 'room:join', { playerId: 'player_multi_bravo_456', roomCode: room.code, displayName: 'B', commandId: 'command_multi_join_b' });
    const joinedC = await emit(c, 'room:join', { playerId: 'player_multi_charlie_789', roomCode: room.code, displayName: 'C', commandId: 'command_multi_join_c' });
    assert.equal(joinedB.ok, true); assert.equal(joinedC.ok, true);
    const rejected = await emit(d, 'room:join', { playerId: 'player_multi_delta_012', roomCode: room.code, displayName: 'D', commandId: 'command_multi_join_d' });
    assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'ROOM_FULL');
    await emit(a, 'lobby:set-ready', { roomId: room.id, ready: true, commandId: 'command_multi_ready_a' });
    await emit(b, 'lobby:set-ready', { roomId: room.id, ready: true, commandId: 'command_multi_ready_b' });
    await emit(c, 'lobby:set-ready', { roomId: room.id, ready: true, commandId: 'command_multi_ready_c' });
    const playingPromise = waitForWhere(a, 'room:snapshot', value => value.status === 'playing' && value.players.length === 3);
    const started = await emit(a, 'match:start', { roomId: room.id, commandId: 'command_multi_start' }); assert.equal(started.ok, true);
    const playing = await playingPromise; const endedPromise = waitFor(a, 'round:ended');
    const guessed = await emit(c, 'round:guess', { roomId: room.id, roundId: playing.activeRound.id, guessAppId: 10, commandId: 'command_multi_guess_c' });
    assert.equal(guessed.ok, true); assert.equal(guessed.data.feedback.isCorrect, true);
    const ended = await endedPromise; assert.equal(ended.winnerPlayerId, joinedC.data.playerId);
  });

  it('supports BO3 across multiple authoritative rounds', async () => {
    const { connect } = await fixture(); const a = connect(); const b = connect(); cleanup.push(async () => { a.close(); b.close(); });
    await Promise.all([waitFor(a, 'connect'), waitFor(b, 'connect')]);
    const created = await emit(a, 'room:create', { playerId: 'player_bo3_alpha_123', displayName: 'A', settings: { difficulty: 'normal', bestOf: 3, roundTimeSeconds: 120, visibleFields: ['price'] }, commandId: 'command_bo3_create' });
    const room = created.data.room;
    const joined = await emit(b, 'room:join', { playerId: 'player_bo3_bravo_456', roomCode: room.code, displayName: 'B', commandId: 'command_bo3_join' }); assert.equal(joined.ok, true);
    await emit(a, 'lobby:set-ready', { roomId: room.id, ready: true, commandId: 'command_bo3_ready_a' }); await emit(b, 'lobby:set-ready', { roomId: room.id, ready: true, commandId: 'command_bo3_ready_b' });
    const firstPromise = waitForWhere(a, 'room:snapshot', value => value.status === 'playing' && value.match?.roundNumber === 1); await emit(a, 'match:start', { roomId: room.id, commandId: 'command_bo3_start' }); const first = await firstPromise;
    const secondPromise = waitForWhere(a, 'room:snapshot', value => value.status === 'playing' && value.match?.roundNumber === 2); await emit(a, 'round:guess', { roomId: room.id, roundId: first.activeRound.id, guessAppId: 10, commandId: 'command_bo3_guess_1' }); const second = await secondPromise;
    const thirdPromise = waitForWhere(a, 'room:snapshot', value => value.status === 'playing' && value.match?.roundNumber === 3); await emit(b, 'round:guess', { roomId: room.id, roundId: second.activeRound.id, guessAppId: 30, commandId: 'command_bo3_guess_2' }); const third = await thirdPromise;
    const endedPromise = waitFor(a, 'match:ended'); await emit(a, 'round:guess', { roomId: room.id, roundId: third.activeRound.id, guessAppId: 10, commandId: 'command_bo3_guess_3' }); const ended = await endedPromise;
    assert.equal(ended.winnerPlayerId, created.data.playerId); assert.equal(ended.scores[created.data.playerId], 2); assert.equal(ended.scores[joined.data.playerId], 1);
  });

  it('forfeits a round after the reconnect deadline and rejects malicious payloads', async () => {
    const { connect } = await fixture(); const a = connect(); const b = connect(); cleanup.push(async () => { a.close(); b.close(); });
    await Promise.all([waitFor(a, 'connect'), waitFor(b, 'connect')]);
    const invalid = await emit(a, 'room:create', { playerId: 'bad', displayName: 'x'.repeat(100), commandId: 'bad' }); assert.equal(invalid.ok, false); assert.equal(invalid.error.code, 'INVALID_PAYLOAD');
    const created = await emit(a, 'room:create', { playerId: 'player_dc_alpha_123', displayName: 'A', settings: { difficulty: 'normal', bestOf: 1, roundTimeSeconds: 120, visibleFields: ['price'] }, commandId: 'command_dc_create' }); const room = created.data.room;
    await emit(b, 'room:join', { playerId: 'player_dc_bravo_456', roomCode: room.code, displayName: 'B', commandId: 'command_dc_join' });
    await emit(a, 'lobby:set-ready', { roomId: room.id, ready: true, commandId: 'command_dc_ready_a' }); await emit(b, 'lobby:set-ready', { roomId: room.id, ready: true, commandId: 'command_dc_ready_b' });
    const playingPromise = waitForWhere(a, 'room:snapshot', value => value.status === 'playing'); await emit(a, 'match:start', { roomId: room.id, commandId: 'command_dc_start' }); await playingPromise;
    const endedPromise = waitFor(a, 'round:ended'); b.close(); const ended = await endedPromise; assert.equal(ended.reason, 'disconnect_timeout'); assert.equal(ended.winnerPlayerId, created.data.playerId);
  });
});
