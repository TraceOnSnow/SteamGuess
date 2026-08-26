import { randomUUID } from 'node:crypto';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { Server } from 'socket.io';
import { openDatabase, recordMultiplayerMatch } from '../database.js';
import { difficultyPool, loadCatalog } from './catalog.js';
import { createMatchEngine } from './matchEngine.js';
import { MemoryRoomStore, RedisRoomStore } from './roomStore.js';
import {
  createSchema,
  fail,
  guessSchema,
  joinSchema,
  ok,
  readySchema,
  rematchSchema,
  resumeSchema,
  roomSchema,
  settingsUpdateSchema,
  surrenderSchema,
} from './protocol.js';

const DEFAULT_SETTINGS = {
  difficulty: 'normal',
  bestOf: 1,
  maxPlayers: 4,
  roundTimeSeconds: 120,
  visibleFields: ['price', 'popularity', 'reviews', 'rating', 'releaseDate', 'companies', 'tags'],
};

function publicGame(game) {
  return {
    appId: game.appId,
    name: game.name,
    localizedNames: game.localizedNames,
    header_image: game.header_image,
    releaseDate: game.releaseDate,
    price: game.price,
    popularity: game.popularity,
    reviews: game.reviews,
    tags: game.tags,
  };
}

function resolveRoomStore({ roomStore, redisUrl }) {
  const selected = String(roomStore ?? process.env.STEAMGUESS_ROOM_STORE ?? '').trim() || null;
  const url = String(redisUrl ?? process.env.STEAMGUESS_REDIS_URL ?? '').trim() || null;
  if (selected && !['memory', 'redis'].includes(selected)) {
    throw new Error('STEAMGUESS_ROOM_STORE must be "memory" or "redis".');
  }
  const kind = selected ?? (url ? 'redis' : 'memory');
  if (kind === 'redis' && !url) {
    throw new Error('STEAMGUESS_REDIS_URL is required when STEAMGUESS_ROOM_STORE=redis.');
  }
  return { kind, url };
}

export function createMultiplayerServer(httpServer, {
  rootDir,
  dbPath,
  catalog: catalogOverride,
  now = () => Date.now(),
  random = Math.random,
  countdownMs = 3_000,
  nextRoundDelayMs = 3_500,
  disconnectGraceMs = 30_000,
  reconcileIntervalMs = 1_000,
  roomStore: roomStoreOption,
  redisUrl,
  redisPrefix = process.env.STEAMGUESS_REDIS_PREFIX || 'steamguess:multiplayer',
} = {}) {
  const catalog = catalogOverride ?? loadCatalog(rootDir);
  const catalogById = new Map(catalog.map(game => [game.appId, game]));
  const storeConfig = resolveRoomStore({ roomStore: roomStoreOption, redisUrl });
  const io = new Server(httpServer, {
    path: '/socket.io',
    serveClient: false,
    cors: false,
    maxHttpBufferSize: 32_768,
    transports: ['websocket'],
    allowRequest: (request, callback) => {
      const origin = request.headers.origin;
      const host = request.headers['x-forwarded-host'] || request.headers.host;
      if (!origin || !host) return callback(null, true);
      try {
        callback(null, new URL(origin).host === String(host).split(',')[0].trim());
      } catch {
        callback(null, false);
      }
    },
  });

  const redisClients = [];
  const timers = new Map();
  const transitionTimers = new Map();
  const disconnectTimers = new Map();
  const guessLimits = new Map();
  let store;
  let initializationError = null;
  let database;
  let reconciling = false;
  let closing = false;
  const backgroundTasks = new Set();

  const db = () => database ??= openDatabase(dbPath);
  const ready = (async () => {
    if (storeConfig.kind === 'memory') {
      store = new MemoryRoomStore({ now });
      return;
    }

    const commandClient = createClient({ url: storeConfig.url });
    const pubClient = commandClient.duplicate();
    const subClient = commandClient.duplicate();
    redisClients.push(commandClient, pubClient, subClient);
    for (const client of redisClients) {
      client.on('error', error => {
        console.error('Multiplayer Redis error', error);
      });
    }
    await Promise.all(redisClients.map(client => client.connect()));
    io.adapter(createAdapter(pubClient, subClient, { key: `${redisPrefix}:socket.io` }));
    store = new RedisRoomStore({ client: commandClient, prefix: redisPrefix, now });
    await store.cleanup();
  })().catch(error => {
    initializationError = error;
    console.error('Unable to initialize multiplayer room store', error);
  });

  async function ensureReady() {
    await ready;
    if (initializationError) throw initializationError;
  }

  io.use(async (_socket, next) => {
    try {
      await ensureReady();
      next();
    } catch {
      next(new Error('Multiplayer room store is unavailable.'));
    }
  });

  function runInBackground(operation) {
    const task = Promise.resolve(operation).finally(() => backgroundTasks.delete(task));
    backgroundTasks.add(task);
    return task;
  }

  function playerForSocket(room, socket) {
    return room.players.find(player => player.socketId === socket.id);
  }

  function allowGuess(playerId) {
    const current = now();
    const entry = guessLimits.get(playerId);
    if (!entry || current - entry.startedAt >= 10_000) {
      guessLimits.set(playerId, { startedAt: current, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= 15;
  }

  function view(room, viewerId) {
    const viewerRound = room.activeRound?.players[viewerId];
    return {
      id: room.id,
      code: room.code,
      status: room.status,
      revision: room.revision,
      hostPlayerId: room.hostPlayerId,
      countdownEndsAt: room.countdownEndsAt ?? null,
      settings: room.settings,
      players: room.players.map(player => ({
        id: player.id,
        displayName: player.displayName,
        ready: player.ready,
        connected: player.connected,
        rematch: player.rematch ?? false,
        guessCount: room.activeRound?.players[player.id]?.guesses.length ?? 0,
        finished: room.activeRound?.players[player.id]?.finished ?? false,
      })),
      match: room.match ? {
        id: room.match.id,
        roundNumber: room.match.roundNumber,
        scores: room.match.scores,
        winnerPlayerId: room.match.winnerPlayerId,
      } : null,
      activeRound: room.activeRound ? {
        id: room.activeRound.id,
        startedAt: room.activeRound.startedAt,
        endsAt: room.activeRound.endsAt,
        guesses: viewerRound?.guesses ?? [],
      } : null,
    };
  }

  function emitSnapshots(room) {
    for (const player of room.players) {
      if (player.socketId) io.to(player.socketId).emit('room:snapshot', view(room, player.id));
    }
  }

  function bindState(player, socket) {
    const previousSocketId = player.socketId;
    player.socketId = socket.id;
    player.connected = true;
    player.disconnectExpiresAt = null;
    return previousSocketId;
  }

  async function attachSocket(room, player, socket, previousSocketId = null) {
    clearTimeout(disconnectTimers.get(player.id));
    disconnectTimers.delete(player.id);
    await socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.playerId = player.id;
    if (previousSocketId && previousSocketId !== socket.id) {
      io.in(previousSocketId).disconnectSockets(true);
    }
  }

  function buildRecord(room) {
    return {
      id: room.match.id,
      roomCode: room.code,
      difficulty: room.settings.difficulty,
      bestOf: room.settings.bestOf,
      status: 'finished',
      winnerPlayerId: room.match.winnerPlayerId,
      startedAt: new Date(room.match.startedAt).toISOString(),
      finishedAt: new Date(now()).toISOString(),
      players: room.players.map(player => ({
        id: player.id,
        displayName: player.displayName,
        score: room.match.scores[player.id] ?? 0,
        outcome: room.match.winnerPlayerId === player.id ? 'won' : 'lost',
        reconnectCount: player.reconnectCount ?? 0,
      })),
      rounds: room.match.rounds,
    };
  }

  function endRoundState(room, winnerPlayerId, reason) {
    if (!room.activeRound || room.status !== 'playing') return null;
    const round = room.activeRound;
    const answer = catalogById.get(round.answerAppId);
    if (winnerPlayerId) room.match.scores[winnerPlayerId] += 1;
    room.match.rounds.push({
      id: round.id,
      roundNumber: room.match.roundNumber,
      answerAppId: round.answerAppId,
      winnerPlayerId,
      endReason: reason,
      startedAt: new Date(round.startedAt).toISOString(),
      finishedAt: new Date(now()).toISOString(),
      players: room.players.map(player => ({
        playerId: player.id,
        outcome: winnerPlayerId === player.id ? 'won' : winnerPlayerId ? 'lost' : 'draw',
        guesses: round.players[player.id].guesses,
      })),
    });
    const target = Math.ceil(room.settings.bestOf / 2);
    const matchWinner = room.players.find(player => room.match.scores[player.id] >= target);
    room.status = matchWinner ? 'finished' : 'round_over';
    room.match.winnerPlayerId = matchWinner?.id ?? null;
    room.activeRound = null;
    room.nextRoundStartsAt = matchWinner ? null : now() + nextRoundDelayMs;
    store.bump(room);
    return {
      roundEvent: {
        roomId: room.id,
        roundId: round.id,
        winnerPlayerId,
        reason,
        answer: publicGame(answer),
        stateVersion: room.revision,
      },
      matchEvent: matchWinner ? {
        roomId: room.id,
        winnerPlayerId: matchWinner.id,
        scores: room.match.scores,
      } : null,
      record: matchWinner ? buildRecord(room) : null,
      scheduleNextRound: !matchWinner,
    };
  }

  const engine = createMatchEngine({
    catalog,
    random,
    now,
    onRoundEnd: endRoundState,
  });

  function startRoundState(room) {
    if (
      room.status !== 'countdown'
      || room.players.length < 2
      || room.players.length > room.settings.maxPlayers
    ) return { changed: false };

    if (room.players.some(player => !player.connected)) {
      room.status = 'lobby';
      room.match = null;
      room.countdownEndsAt = null;
      for (const player of room.players) player.ready = false;
      store.bump(room);
      return { changed: true, playing: false };
    }
    room.countdownEndsAt = null;
    room.nextRoundStartsAt = null;
    room.status = 'playing';
    room.match.roundNumber += 1;
    engine.startRound(room);
    store.bump(room);
    return { changed: true, playing: true };
  }

  function forfeitPlayerState(room, playerId, reason) {
    const state = room.activeRound?.players[playerId];
    if (!state || state.finished) return null;
    state.finished = true;
    const contenders = room.players.filter(player =>
      player.id !== playerId
      && player.connected
      && !room.activeRound.players[player.id]?.finished
    );
    if (contenders.length === 1) return endRoundState(room, contenders[0].id, reason);
    if (Object.values(room.activeRound.players).every(value => value.finished)) {
      return endRoundState(room, null, reason);
    }
    return null;
  }

  function clearRoomTimers(roomId) {
    clearTimeout(timers.get(roomId));
    timers.delete(roomId);
    clearTimeout(transitionTimers.get(roomId));
    transitionTimers.delete(roomId);
  }

  async function publishRoundTransition(room, transition) {
    if (!room || !transition) return;
    clearRoomTimers(room.id);
    io.to(room.id).emit('round:ended', transition.roundEvent);
    emitSnapshots(room);
    if (transition.record) {
      try {
        recordMultiplayerMatch(db(), transition.record);
      } catch (error) {
        console.error('Unable to persist multiplayer match', error);
      }
    }
    if (transition.matchEvent) {
      io.to(room.id).emit('match:ended', transition.matchEvent);
    } else if (transition.scheduleNextRound) {
      scheduleNextRound(room);
    }
  }

  async function startRound(roomId) {
    const mutation = await store.mutate(roomId, room => startRoundState(room));
    if (!mutation.found || !mutation.value?.changed || !mutation.room) return;
    if (mutation.value.playing) scheduleRoundTimeout(mutation.room);
    emitSnapshots(mutation.room);
  }

  function scheduleRoundTimeout(room) {
    clearTimeout(timers.get(room.id));
    if (!room.activeRound) return;
    const delayMs = Math.max(0, room.activeRound.endsAt - now());
    const timer = setTimeout(() => {
      if (closing) return;
      void runInBackground(finishRound(room.id, null, 'timeout', current =>
        current.status === 'playing' && current.activeRound?.endsAt <= now()
      ));
    }, delayMs + 5);
    timer.unref();
    timers.set(room.id, timer);
  }

  function scheduleCountdown(room) {
    clearTimeout(transitionTimers.get(room.id));
    const delayMs = Math.max(0, (room.countdownEndsAt ?? now()) - now());
    const timer = setTimeout(() => {
      if (closing) return;
      void runInBackground(
        startRound(room.id).catch(error => console.error('Unable to start multiplayer round', error)),
      );
    }, delayMs + 5);
    timer.unref();
    transitionTimers.set(room.id, timer);
  }

  function scheduleNextRound(room) {
    clearTimeout(transitionTimers.get(room.id));
    const delayMs = Math.max(0, (room.nextRoundStartsAt ?? now()) - now());
    const timer = setTimeout(async () => {
      if (closing) return;
      try {
        const mutation = await store.mutate(room.id, current => {
          if (
            current.status !== 'round_over'
            || (current.nextRoundStartsAt ?? Infinity) > now()
          ) return false;
          current.status = 'countdown';
          current.nextRoundStartsAt = null;
          current.countdownEndsAt = now() + countdownMs;
          store.bump(current);
          return true;
        });
        if (mutation.value && mutation.room) {
          emitSnapshots(mutation.room);
          scheduleCountdown(mutation.room);
        }
      } catch (error) {
        console.error('Unable to schedule next multiplayer round', error);
      }
    }, delayMs + 5);
    timer.unref();
    transitionTimers.set(room.id, timer);
  }

  async function finishRound(roomId, winnerPlayerId, reason, predicate = () => true) {
    const mutation = await store.mutate(roomId, room => {
      if (!predicate(room)) return null;
      return endRoundState(room, winnerPlayerId, reason);
    });
    if (mutation.value && mutation.room) await publishRoundTransition(mutation.room, mutation.value);
    return mutation;
  }

  async function processDisconnectTimeout(roomId, playerId, deadline) {
    const mutation = await store.mutate(roomId, room => {
      const player = store.findPlayer(room, playerId);
      if (
        !player
        || player.connected
        || player.disconnectExpiresAt !== deadline
        || deadline > now()
        || room.status !== 'playing'
      ) return { changed: false, transition: null };
      const transition = forfeitPlayerState(room, playerId, 'disconnect_timeout');
      if (!transition) store.bump(room);
      return { changed: true, transition };
    });
    if (!mutation.value?.changed || !mutation.room) return;
    if (mutation.value.transition) await publishRoundTransition(mutation.room, mutation.value.transition);
    else emitSnapshots(mutation.room);
  }

  function register(socket, event, schema, handler) {
    socket.on(event, async (payload, ack = () => {}) => {
      const parsed = schema.safeParse(payload);
      if (!parsed.success) return ack(fail('INVALID_PAYLOAD', 'Invalid request payload.'));
      try {
        await ensureReady();
        await handler(parsed.data, ack);
      } catch (error) {
        console.error(`multiplayer ${event}`, error);
        ack(fail('INTERNAL_ERROR', 'Server could not process the request.'));
      }
    });
  }

  io.on('connection', socket => {
    register(socket, 'room:create', createSchema, async (data, ack) => {
      const settings = { ...DEFAULT_SETTINGS, ...data.settings };
      const created = await store.create({
        playerId: data.playerId,
        displayName: data.displayName,
        settings,
        pool: difficultyPool(catalog, settings.difficulty),
        socketId: socket.id,
      });
      await attachSocket(created.room, created.player, socket);
      ack(ok({
        room: view(created.room, created.player.id),
        playerId: created.player.id,
        resumeToken: created.resumeToken,
      }, created.room.revision));
    });

    register(socket, 'room:join', joinSchema, async (data, ack) => {
      const located = await store.findByCode(data.roomCode);
      if (!located) return ack(fail('ROOM_NOT_FOUND', 'Room not found.'));
      const mutation = await store.mutate(located.id, room => {
        const result = store.addPlayer(room, data.playerId, data.displayName);
        if (result.error) return { response: fail(...result.error) };
        const previousSocketId = bindState(result.player, socket);
        return { playerId: result.player.id, resumeToken: result.resumeToken, previousSocketId };
      });
      if (!mutation.found) return ack(fail('ROOM_NOT_FOUND', 'Room not found.'));
      if (mutation.value.response) return ack(mutation.value.response);
      const player = store.findPlayer(mutation.room, mutation.value.playerId);
      await attachSocket(mutation.room, player, socket, mutation.value.previousSocketId);
      ack(ok({
        room: view(mutation.room, player.id),
        playerId: player.id,
        resumeToken: mutation.value.resumeToken,
      }, mutation.room.revision));
      emitSnapshots(mutation.room);
    });

    register(socket, 'room:resume', resumeSchema, async (data, ack) => {
      const located = await store.findByCode(data.roomCode);
      if (!located) return ack(fail('RESUME_TOKEN_INVALID', 'Unable to resume this room.'));
      const mutation = await store.mutate(located.id, room => {
        const player = store.resume(room, data.playerId, data.resumeToken);
        if (!player) return { invalid: true };
        player.reconnectCount = (player.reconnectCount ?? 0) + 1;
        const previousSocketId = bindState(player, socket);
        store.bump(room);
        return { playerId: player.id, previousSocketId };
      });
      if (!mutation.found || mutation.value.invalid) {
        return ack(fail('RESUME_TOKEN_INVALID', 'Unable to resume this room.'));
      }
      const player = store.findPlayer(mutation.room, mutation.value.playerId);
      await attachSocket(mutation.room, player, socket, mutation.value.previousSocketId);
      ack(ok({ room: view(mutation.room, player.id) }, mutation.room.revision));
      emitSnapshots(mutation.room);
    });

    register(socket, 'room:leave', roomSchema, async (data, ack) => {
      const mutation = await store.mutate(data.roomId, (room, control) => {
        const player = playerForSocket(room, socket);
        if (!player) return { response: fail('NOT_ROOM_MEMBER', 'You are not in this room.') };
        const transition = room.status === 'playing'
          ? forfeitPlayerState(room, player.id, 'player_left')
          : null;
        room.players = room.players.filter(value => value.id !== player.id);
        if (room.players.length === 0) {
          control.deleteRoom();
          return { playerId: player.id, transition, deleted: true };
        }
        if (room.hostPlayerId === player.id) room.hostPlayerId = room.players[0].id;
        store.bump(room);
        return { playerId: player.id, transition, deleted: false };
      });
      if (!mutation.found || mutation.value.response) {
        return ack(mutation.value?.response ?? fail('NOT_ROOM_MEMBER', 'You are not in this room.'));
      }
      clearTimeout(disconnectTimers.get(mutation.value.playerId));
      disconnectTimers.delete(mutation.value.playerId);
      await socket.leave(data.roomId);
      socket.data.roomId = null;
      socket.data.playerId = null;
      ack(ok({}));
      if (mutation.room && mutation.value.transition) {
        await publishRoundTransition(mutation.room, mutation.value.transition);
      } else if (mutation.room) {
        emitSnapshots(mutation.room);
      }
    });

    register(socket, 'lobby:set-ready', readySchema, async (data, ack) => {
      const mutation = await store.mutate(data.roomId, room => {
        const player = playerForSocket(room, socket);
        if (!player) return { response: fail('NOT_ROOM_MEMBER', 'You are not in this room.') };
        if (room.status !== 'lobby') {
          return { response: fail('INVALID_ROOM_STATE', 'Readiness can only change in the lobby.') };
        }
        player.ready = data.ready;
        store.bump(room);
        return { response: ok({}, room.revision), changed: true };
      });
      const response = mutation.value?.response ?? fail('NOT_ROOM_MEMBER', 'You are not in this room.');
      ack(response);
      if (mutation.value?.changed) emitSnapshots(mutation.room);
    });

    register(socket, 'lobby:update-settings', settingsUpdateSchema, async (data, ack) => {
      const mutation = await store.mutate(data.roomId, room => {
        const player = playerForSocket(room, socket);
        if (!player) return { response: fail('NOT_ROOM_MEMBER', 'You are not in this room.') };
        if (room.hostPlayerId !== player.id) {
          return { response: fail('NOT_HOST', 'Only the host can change settings.') };
        }
        if (room.status !== 'lobby' || room.revision !== data.expectedVersion) {
          return { response: fail('INVALID_ROOM_STATE', 'Room settings are stale or locked.') };
        }
        if (data.settings.maxPlayers < room.players.length) {
          return { response: fail('INVALID_SETTINGS', 'Maximum players cannot be lower than the current player count.') };
        }
        room.settings = data.settings;
        room.pool = difficultyPool(catalog, data.settings.difficulty);
        store.bump(room);
        return { response: ok({}, room.revision), changed: true };
      });
      const response = mutation.value?.response ?? fail('NOT_ROOM_MEMBER', 'You are not in this room.');
      ack(response);
      if (mutation.value?.changed) emitSnapshots(mutation.room);
    });

    register(socket, 'match:start', roomSchema, async (data, ack) => {
      const mutation = await store.mutate(data.roomId, room => {
        const player = playerForSocket(room, socket);
        if (!player) return { response: fail('NOT_ROOM_MEMBER', 'You are not in this room.') };
        if (room.hostPlayerId !== player.id) {
          return { response: fail('NOT_HOST', 'Only the host can start.') };
        }
        if (
          room.status !== 'lobby'
          || room.players.length < 2
          || room.players.length > room.settings.maxPlayers
          || room.players.some(value => !value.ready)
        ) {
          return { response: fail('INVALID_ROOM_STATE', 'At least two players must be ready.') };
        }
        room.match = {
          id: `match_${randomUUID()}`,
          roundNumber: 0,
          scores: Object.fromEntries(room.players.map(value => [value.id, 0])),
          winnerPlayerId: null,
          startedAt: now(),
          rounds: [],
        };
        room.status = 'countdown';
        room.nextRoundStartsAt = null;
        room.countdownEndsAt = now() + countdownMs;
        store.bump(room);
        return { response: ok({}, room.revision), changed: true };
      });
      const response = mutation.value?.response ?? fail('NOT_ROOM_MEMBER', 'You are not in this room.');
      ack(response);
      if (mutation.value?.changed) {
        emitSnapshots(mutation.room);
        scheduleCountdown(mutation.room);
      }
    });

    register(socket, 'round:guess', guessSchema, async (data, ack) => {
      const mutation = await store.mutate(data.roomId, room => {
        const player = playerForSocket(room, socket);
        if (!player) return { response: fail('NOT_ROOM_MEMBER', 'You are not in this room.') };
        const cacheKey = `${player.id}:${data.commandId}`;
        const cached = room.commandResults.get(cacheKey);
        if (cached) return { response: cached, cached: true };
        if (!allowGuess(player.id)) {
          return { response: fail('GUESS_RATE_LIMITED', 'Too many guesses. Please slow down.') };
        }
        if (room.status !== 'playing' || room.activeRound?.id !== data.roundId) {
          return { response: fail('ROUND_STALE', 'This round is no longer active.') };
        }
        if (room.activeRound.endsAt <= now()) {
          const transition = endRoundState(room, null, 'timeout');
          return {
            response: fail('ROUND_STALE', 'This round has ended.'),
            transition,
          };
        }
        const result = engine.guess(room, player.id, data.guessAppId);
        if (result.error) return { response: fail(...result.error) };
        const { roundEnd: transition, ...publicResult } = result;
        const visible = new Set(room.settings.visibleFields);
        publicResult.feedback.fields = publicResult.feedback.fields.filter(field => visible.has(field.fieldName));
        if (!visible.has('tags')) publicResult.feedback.matchingTags = [];
        if (!visible.has('companies')) publicResult.feedback.matchingCompanies = [];
        store.bump(room);
        const response = ok(publicResult, room.revision);
        room.commandResults.set(cacheKey, response);
        if (room.commandResults.size > 200) {
          room.commandResults.delete(room.commandResults.keys().next().value);
        }
        return {
          response,
          transition,
          guessEvent: {
            roomId: room.id,
            roundId: data.roundId,
            guessAppId: data.guessAppId,
            ...publicResult,
            stateVersion: room.revision,
          },
        };
      });
      const response = mutation.value?.response ?? fail('NOT_ROOM_MEMBER', 'You are not in this room.');
      ack(response);
      if (!mutation.room || mutation.value?.cached) return;
      if (mutation.value?.guessEvent) socket.emit('round:guess-result', mutation.value.guessEvent);
      if (mutation.value?.transition) {
        await publishRoundTransition(mutation.room, mutation.value.transition);
      } else if (mutation.value?.guessEvent) {
        emitSnapshots(mutation.room);
      }
    });

    register(socket, 'round:surrender', surrenderSchema, async (data, ack) => {
      const mutation = await store.mutate(data.roomId, room => {
        const player = playerForSocket(room, socket);
        if (!player) return { response: fail('NOT_ROOM_MEMBER', 'You are not in this room.') };
        if (room.status !== 'playing' || room.activeRound?.id !== data.roundId) {
          return { response: fail('ROUND_STALE', 'This round is no longer active.') };
        }
        const transition = forfeitPlayerState(room, player.id, 'surrender');
        if (!transition) store.bump(room);
        return { response: ok({}, room.revision), changed: true, transition };
      });
      const response = mutation.value?.response ?? fail('NOT_ROOM_MEMBER', 'You are not in this room.');
      ack(response);
      if (mutation.value?.transition) {
        await publishRoundTransition(mutation.room, mutation.value.transition);
      } else if (mutation.value?.changed) {
        emitSnapshots(mutation.room);
      }
    });

    register(socket, 'match:rematch', rematchSchema, async (data, ack) => {
      const mutation = await store.mutate(data.roomId, room => {
        const player = playerForSocket(room, socket);
        if (!player) return { response: fail('NOT_ROOM_MEMBER', 'You are not in this room.') };
        if (room.status !== 'finished') {
          return { response: fail('INVALID_ROOM_STATE', 'The match is not finished.') };
        }
        player.rematch = data.accept;
        if (room.players.every(value => value.rematch)) {
          room.status = 'lobby';
          room.match = null;
          for (const value of room.players) {
            value.ready = false;
            value.rematch = false;
          }
        }
        store.bump(room);
        return { response: ok({}, room.revision), changed: true };
      });
      const response = mutation.value?.response ?? fail('NOT_ROOM_MEMBER', 'You are not in this room.');
      ack(response);
      if (mutation.value?.changed) emitSnapshots(mutation.room);
    });

    socket.on('disconnect', () => {
      if (closing) return;
      void runInBackground((async () => {
        try {
          await ensureReady();
          const roomId = socket.data.roomId;
          if (!roomId) return;
          const mutation = await store.mutate(roomId, room => {
            const player = store.findPlayer(room, socket.data.playerId);
            if (!player || player.socketId !== socket.id) return { changed: false };
            player.connected = false;
            player.socketId = null;
            player.disconnectExpiresAt = room.status === 'playing' ? now() + disconnectGraceMs : null;
            store.bump(room);
            return {
              changed: true,
              playerId: player.id,
              disconnectExpiresAt: player.disconnectExpiresAt,
            };
          });
          if (!mutation.value?.changed || !mutation.room) return;
          emitSnapshots(mutation.room);
          if (mutation.value.disconnectExpiresAt) {
            const { playerId, disconnectExpiresAt } = mutation.value;
            const timer = setTimeout(() => {
              void processDisconnectTimeout(roomId, playerId, disconnectExpiresAt)
                .catch(error => console.error('Unable to process multiplayer disconnect timeout', error));
            }, Math.max(0, disconnectExpiresAt - now()) + 5);
            timer.unref();
            disconnectTimers.set(playerId, timer);
          }
        } catch (error) {
          console.error('Unable to update disconnected multiplayer player', error);
        }
      })());
    });
  });

  async function reconcileRooms() {
    if (reconciling) return;
    reconciling = true;
    try {
      await ensureReady();
      const rooms = await store.listRooms();
      for (const listed of rooms) {
        const mutation = await store.mutate(listed.id, room => {
          if (room.status === 'countdown' && room.countdownEndsAt <= now()) {
            return { action: 'start', start: startRoundState(room) };
          }
          if (
            room.status === 'round_over'
            && room.nextRoundStartsAt
            && room.nextRoundStartsAt <= now()
          ) {
            room.status = 'countdown';
            room.nextRoundStartsAt = null;
            room.countdownEndsAt = now() + countdownMs;
            store.bump(room);
            return { action: 'countdown' };
          }
          if (room.status === 'playing' && room.activeRound?.endsAt <= now()) {
            return { action: 'finish', transition: endRoundState(room, null, 'timeout') };
          }
          if (room.status === 'playing') {
            for (const player of room.players) {
              if (
                !player.connected
                && player.disconnectExpiresAt
                && player.disconnectExpiresAt <= now()
              ) {
                const transition = forfeitPlayerState(room, player.id, 'disconnect_timeout');
                if (!transition) store.bump(room);
                return { action: 'disconnect', transition };
              }
            }
          }
          return { action: null };
        });
        if (!mutation.room || !mutation.value?.action) continue;
        if (mutation.value.action === 'start') {
          if (mutation.value.start.playing) scheduleRoundTimeout(mutation.room);
          emitSnapshots(mutation.room);
        } else if (mutation.value.action === 'countdown') {
          emitSnapshots(mutation.room);
          scheduleCountdown(mutation.room);
        } else if (mutation.value.transition) {
          await publishRoundTransition(mutation.room, mutation.value.transition);
        } else {
          emitSnapshots(mutation.room);
        }
      }
    } catch (error) {
      console.error('Unable to reconcile multiplayer rooms', error);
    } finally {
      reconciling = false;
    }
  }

  const reconcileTimer = setInterval(() => {
    if (!closing) void runInBackground(reconcileRooms());
  }, reconcileIntervalMs);
  reconcileTimer.unref();

  const cleanupTimer = setInterval(() => {
    if (closing) return;
    void runInBackground((async () => {
      try {
        await ensureReady();
        await store.cleanup();
        const cutoff = now() - 60_000;
        for (const [key, value] of guessLimits) {
          if (value.startedAt < cutoff) guessLimits.delete(key);
        }
      } catch (error) {
        console.error('Unable to clean up multiplayer rooms', error);
      }
    })());
  }, 60_000);
  cleanupTimer.unref();

  return {
    io,
    ready,
    health: () => ({
      status: initializationError ? 'error' : store ? 'ok' : 'starting',
      roomStore: store?.kind ?? storeConfig.kind,
      rooms: store?.roomCount ?? 0,
      connections: io.engine.clientsCount,
    }),
    close: async () => {
      closing = true;
      clearInterval(reconcileTimer);
      clearInterval(cleanupTimer);
      for (const timer of timers.values()) clearTimeout(timer);
      for (const timer of transitionTimers.values()) clearTimeout(timer);
      for (const timer of disconnectTimers.values()) clearTimeout(timer);
      await Promise.allSettled([...backgroundTasks]);
      await new Promise(resolve => io.close(resolve));
      database?.close();
      await ready;
      await store?.close();
      await Promise.all(redisClients.map(async client => {
        if (client.isOpen) await client.quit();
      }));
    },
  };
}
