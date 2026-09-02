import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createClient as createRedisClient } from 'redis';
import { io as createSocketClient } from 'socket.io-client';
import { createMultiplayerServer } from '../multiplayer/index.js';
import { RedisRoomStore } from '../multiplayer/roomStore.js';
import { openDatabase } from '../database.js';

const redisUrl = process.env.STEAMGUESS_TEST_REDIS_URL
  || process.env.STEAMGUESS_REDIS_URL
  || 'redis://127.0.0.1:6379';
const cleanup = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

const testCatalog = [10, 30].map((appId, index) => ({
  appId,
  name: `Redis Test Game ${appId}`,
  localizedNames: { zh: `Redis 测试游戏 ${appId}` },
  releaseDate: `202${index}-01-01`,
  price: {
    us: { currency: 'USD', regular: index + 1 },
    cn: { currency: 'CNY', regular: (index + 1) * 10 },
  },
  popularity: { current: 100 + index, peak: 1000 + index },
  reviews: { total: 100 + index, positive: 90 + index, negative: 10 },
  tags: {
    developers: [`Redis Test Dev ${appId}`],
    publishers: [`Redis Test Pub ${appId}`],
    userTags: [`Redis Test Tag ${appId}`],
  },
  difficulty: {
    score: index * 25,
    level: index === 0 ? 'easy' : 'normal',
    source: 'test',
  },
}));

function emit(socket, event, payload) {
  return new Promise(resolve => socket.emit(event, payload, resolve));
}

function waitFor(socket, event) {
  return new Promise(resolve => socket.once(event, resolve));
}

function waitForWhere(socket, event, predicate) {
  return new Promise(resolve => {
    const listener = value => {
      if (!predicate(value)) return;
      socket.off(event, listener);
      resolve(value);
    };
    socket.on(event, listener);
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function redisProbe() {
  const client = createRedisClient({
    url: redisUrl,
    socket: {
      connectTimeout: 300,
      reconnectStrategy: false,
    },
  });
  client.on('error', () => {});
  try {
    await client.connect();
    await client.ping();
    return client;
  } catch {
    if (client.isOpen) client.destroy();
    return null;
  }
}

async function listen(http) {
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  return http.address().port;
}

async function closeHttp(http) {
  if (http.listening) await new Promise(resolve => http.close(resolve));
}

async function deletePrefix(client, prefix) {
  const keys = [];
  for await (const key of client.scanIterator({ MATCH: `${prefix}:*`, COUNT: 100 })) {
    keys.push(key);
  }
  if (keys.length) await client.del(...keys);
}

describe('Redis multiplayer room store', () => {
  it('rejects a stale writer after its distributed lock is superseded', async t => {
    const firstClient = await redisProbe();
    if (!firstClient) {
      t.skip(`Redis is unavailable at ${redisUrl}`);
      return;
    }

    const secondClient = firstClient.duplicate();
    secondClient.on('error', () => {});
    await secondClient.connect();
    const prefix = `steamguess:test:fencing:${randomUUID()}`;
    const firstStore = new RedisRoomStore({
      client: firstClient,
      prefix,
      lockTtlMs: 1_000,
      lockWaitMs: 1_000,
    });
    const secondStore = new RedisRoomStore({
      client: secondClient,
      prefix,
      lockTtlMs: 1_000,
      lockWaitMs: 1_000,
    });
    cleanup.push(async () => {
      await deletePrefix(firstClient, prefix);
      if (secondClient.isOpen) await secondClient.quit();
      if (firstClient.isOpen) await firstClient.quit();
    });

    const created = await firstStore.create({
      playerId: 'player_fencing_alpha_123',
      displayName: 'A',
      settings: { maxPlayers: 2 },
      pool: [],
      socketId: null,
    });
    let releaseStaleWriter;
    let staleWriterStarted;
    const started = new Promise(resolve => { staleWriterStarted = resolve; });
    const gate = new Promise(resolve => { releaseStaleWriter = resolve; });
    const staleWrite = firstStore.mutate(created.room.id, async room => {
      room.settings.marker = 'stale';
      firstStore.bump(room);
      staleWriterStarted();
      await gate;
    });
    await started;

    await firstClient.set(firstStore.lockKey(created.room.id), 'superseded', { PX: 30 });
    await delay(40);
    const freshWrite = await secondStore.mutate(created.room.id, room => {
      room.settings.marker = 'fresh';
      secondStore.bump(room);
    });
    assert.equal(freshWrite.room.settings.marker, 'fresh');

    releaseStaleWriter();
    await assert.rejects(staleWrite, /Lost multiplayer room lock/);
    assert.equal((await secondStore.findById(created.room.id)).settings.marker, 'fresh');
  });

  it('shares one authoritative room across two Node server instances', async t => {
    const redis = await redisProbe();
    if (!redis) {
      t.skip(`Redis is unavailable at ${redisUrl}`);
      return;
    }

    const prefix = `steamguess:test:${randomUUID()}`;
    const dbPath = join(tmpdir(), `steamguess-mp-redis-${randomUUID()}.sqlite`);
    const firstHttp = createServer((_, response) => response.end('first'));
    const secondHttp = createServer((_, response) => response.end('second'));
    const options = {
      rootDir: process.cwd(),
      dbPath,
      catalog: testCatalog,
      random: () => 0,
      countdownMs: 10,
      nextRoundDelayMs: 10,
      disconnectGraceMs: 50,
      reconcileIntervalMs: 25,
      roomStore: 'redis',
      redisUrl,
      redisPrefix: prefix,
    };
    const first = createMultiplayerServer(firstHttp, options);
    const second = createMultiplayerServer(secondHttp, options);
    const [firstPort, secondPort] = await Promise.all([listen(firstHttp), listen(secondHttp)]);
    const a = createSocketClient(`http://127.0.0.1:${firstPort}`, {
      transports: ['websocket'],
      forceNew: true,
    });
    const b = createSocketClient(`http://127.0.0.1:${secondPort}`, {
      transports: ['websocket'],
      forceNew: true,
    });

    cleanup.push(async () => {
      a.close();
      b.close();
      await Promise.all([first.close(), second.close()]);
      await Promise.all([closeHttp(firstHttp), closeHttp(secondHttp)]);
      await deletePrefix(redis, prefix);
      await redis.quit();
      for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
    });

    await Promise.all([waitFor(a, 'connect'), waitFor(b, 'connect')]);
    await Promise.all([first.ready, second.ready]);
    assert.equal(first.health().status, 'ok');
    assert.equal(second.health().status, 'ok');
    assert.equal(first.health().roomStore, 'redis');
    assert.equal(second.health().roomStore, 'redis');
    const created = await emit(a, 'room:create', {
      playerId: 'player_redis_alpha_123',
      displayName: 'A',
      settings: {
        difficulty: 'normal',
        bestOf: 1,
        maxPlayers: 4,
        roundTimeSeconds: 120,
        visibleFields: ['price'],
      },
      commandId: 'command_redis_create',
    });
    assert.equal(created.ok, true);

    const joinedSnapshot = waitForWhere(a, 'room:snapshot', room => room.players.length === 2);
    const joined = await emit(b, 'room:join', {
      playerId: 'player_redis_bravo_456',
      roomCode: created.data.room.code,
      displayName: 'B',
      commandId: 'command_redis_join',
    });
    assert.equal(joined.ok, true);
    assert.equal((await joinedSnapshot).players.length, 2);

    const [readyA, readyB] = await Promise.all([
      emit(a, 'lobby:set-ready', {
        roomId: created.data.room.id,
        ready: true,
        commandId: 'command_redis_ready_a',
      }),
      emit(b, 'lobby:set-ready', {
        roomId: created.data.room.id,
        ready: true,
        commandId: 'command_redis_ready_b',
      }),
    ]);
    assert.equal(readyA.ok, true);
    assert.equal(readyB.ok, true);
    assert.notEqual(readyA.stateVersion, readyB.stateVersion);

    const playingOnSecond = waitForWhere(b, 'room:snapshot', room => room.status === 'playing');
    const started = await emit(a, 'match:start', {
      roomId: created.data.room.id,
      commandId: 'command_redis_start',
    });
    assert.equal(started.ok, true);
    const playing = await playingOnSecond;

    const endedOnFirst = waitFor(a, 'round:ended');
    const guessed = await emit(b, 'round:guess', {
      roomId: created.data.room.id,
      roundId: playing.activeRound.id,
      guessAppId: 10,
      commandId: 'command_redis_guess',
    });
    assert.equal(guessed.ok, true);
    assert.equal(guessed.data.feedback.isCorrect, true);
    const ended = await endedOnFirst;
    assert.equal(ended.winnerPlayerId, joined.data.playerId);
    assert.equal(ended.answer.appId, 10);

    const stored = openDatabase(dbPath);
    assert.equal(
      stored.prepare('SELECT COUNT(*) AS count FROM multiplayer_matches').get().count,
      1,
    );
    stored.close();
  });
});
