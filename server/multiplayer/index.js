import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { openDatabase, recordMultiplayerMatch } from '../database.js';
import { difficultyPool, loadCatalog } from './catalog.js';
import { createMatchEngine } from './matchEngine.js';
import { MemoryRoomStore } from './roomStore.js';
import { createSchema, fail, guessSchema, joinSchema, ok, readySchema, resumeSchema, roomSchema, settingsUpdateSchema, surrenderSchema, rematchSchema } from './protocol.js';

const DEFAULT_SETTINGS = { difficulty: 'normal', bestOf: 1, maxPlayers: 4, roundTimeSeconds: 120, visibleFields: ['price', 'popularity', 'reviews', 'rating', 'releaseDate', 'companies', 'tags'] };

function publicGame(game) {
  return { appId: game.appId, name: game.name, localizedNames: game.localizedNames, header_image: game.header_image, releaseDate: game.releaseDate, price: game.price, popularity: game.popularity, reviews: game.reviews, tags: game.tags };
}

export function createMultiplayerServer(httpServer, { rootDir, dbPath, now = () => Date.now(), random = Math.random, countdownMs = 3_000, nextRoundDelayMs = 3_500, disconnectGraceMs = 30_000 } = {}) {
  const catalog = loadCatalog(rootDir);
  const catalogById = new Map(catalog.map(game => [game.appId, game]));
  const store = new MemoryRoomStore({ now });
  const io = new Server(httpServer, {
    path: '/socket.io', serveClient: false, cors: false, maxHttpBufferSize: 32_768,
    allowRequest: (request, callback) => {
      const origin = request.headers.origin; const host = request.headers['x-forwarded-host'] || request.headers.host;
      if (!origin || !host) return callback(null, true);
      try { callback(null, new URL(origin).host === String(host).split(',')[0].trim()); } catch { callback(null, false); }
    },
  });
  const locks = new Map(); const timers = new Map(); const transitionTimers = new Map(); const disconnectTimers = new Map(); const guessLimits = new Map(); let database;
  const db = () => database ??= openDatabase(dbPath);

  function withRoomLock(roomId, action) {
    const previous = locks.get(roomId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    const tracked = next.finally(() => { if (locks.get(roomId) === tracked) locks.delete(roomId); });
    locks.set(roomId, tracked);
    return tracked;
  }
  function playerForSocket(room, socket) { return room.players.find(player => player.socketId === socket.id); }
  function allowGuess(playerId) {
    const current = now(); const entry = guessLimits.get(playerId);
    if (!entry || current - entry.startedAt >= 10_000) { guessLimits.set(playerId, { startedAt: current, count: 1 }); return true; }
    entry.count += 1; return entry.count <= 15;
  }
  function view(room, viewerId) {
    const viewerRound = room.activeRound?.players[viewerId];
    return {
      id: room.id, code: room.code, status: room.status, revision: room.revision, hostPlayerId: room.hostPlayerId, countdownEndsAt: room.countdownEndsAt ?? null,
      settings: room.settings,
      players: room.players.map(player => ({ id: player.id, displayName: player.displayName, ready: player.ready, connected: player.connected, rematch: player.rematch ?? false, guessCount: room.activeRound?.players[player.id]?.guesses.length ?? 0, finished: room.activeRound?.players[player.id]?.finished ?? false })),
      match: room.match ? { id: room.match.id, roundNumber: room.match.roundNumber, scores: room.match.scores, winnerPlayerId: room.match.winnerPlayerId } : null,
      activeRound: room.activeRound ? { id: room.activeRound.id, startedAt: room.activeRound.startedAt, endsAt: room.activeRound.endsAt, guesses: viewerRound?.guesses ?? [] } : null,
    };
  }
  function emitSnapshots(room) { for (const player of room.players) if (player.socketId) io.to(player.socketId).emit('room:snapshot', view(room, player.id)); }
  function bind(room, player, socket) { clearTimeout(disconnectTimers.get(player.id)); disconnectTimers.delete(player.id); if (player.socketId && player.socketId !== socket.id) io.sockets.sockets.get(player.socketId)?.disconnect(true); player.socketId = socket.id; player.connected = true; socket.join(room.id); socket.data.roomId = room.id; socket.data.playerId = player.id; }
  function schedule(room) { clearTimeout(timers.get(room.id)); if (!room.activeRound) return; const delay = Math.max(0, room.activeRound.endsAt - now()); timers.set(room.id, setTimeout(() => withRoomLock(room.id, () => { const current = store.findById(room.id); if (current?.status === 'playing' && current.activeRound?.endsAt <= now()) endRound(current, null, 'timeout'); }), delay + 5)); }
  function scheduleCountdown(room) {
    clearTimeout(transitionTimers.get(room.id));
    const delay = Math.max(0, (room.countdownEndsAt ?? now()) - now());
    const timer = setTimeout(() => withRoomLock(room.id, () => {
      const current = store.findById(room.id);
      if (current?.status === 'countdown' && current.countdownEndsAt <= now()) { transitionTimers.delete(room.id); startRound(current); }
    }), delay + 5);
    timer.unref(); transitionTimers.set(room.id, timer);
  }
  function startRound(room) {
    if (room.status !== 'countdown' || room.players.length < 2 || room.players.length > room.settings.maxPlayers) return;
    if (room.players.some(player => !player.connected)) { room.status = 'lobby'; room.match = null; room.countdownEndsAt = null; for (const player of room.players) player.ready = false; store.bump(room); emitSnapshots(room); return; }
    room.countdownEndsAt = null; room.status = 'playing'; room.match.roundNumber += 1; engine.startRound(room); store.bump(room); schedule(room); emitSnapshots(room);
  }
  function record(room) {
    recordMultiplayerMatch(db(), { id: room.match.id, roomCode: room.code, difficulty: room.settings.difficulty, bestOf: room.settings.bestOf, status: 'finished', winnerPlayerId: room.match.winnerPlayerId, startedAt: new Date(room.match.startedAt).toISOString(), finishedAt: new Date(now()).toISOString(), players: room.players.map(player => ({ id: player.id, displayName: player.displayName, score: room.match.scores[player.id] ?? 0, outcome: room.match.winnerPlayerId === player.id ? 'won' : 'lost', reconnectCount: player.reconnectCount ?? 0 })), rounds: room.match.rounds });
  }
  function endRound(room, winnerPlayerId, reason) {
    if (!room.activeRound || room.status !== 'playing') return;
    clearTimeout(timers.get(room.id)); timers.delete(room.id);
    const round = room.activeRound; const answer = catalogById.get(round.answerAppId);
    if (winnerPlayerId) room.match.scores[winnerPlayerId] += 1;
    room.match.rounds.push({ id: round.id, roundNumber: room.match.roundNumber, answerAppId: round.answerAppId, winnerPlayerId, endReason: reason, startedAt: new Date(round.startedAt).toISOString(), finishedAt: new Date(now()).toISOString(), players: room.players.map(player => ({ playerId: player.id, outcome: winnerPlayerId === player.id ? 'won' : winnerPlayerId ? 'lost' : 'draw', guesses: round.players[player.id].guesses })) });
    const target = Math.ceil(room.settings.bestOf / 2); const matchWinner = room.players.find(player => room.match.scores[player.id] >= target);
    room.status = matchWinner ? 'finished' : 'round_over'; room.match.winnerPlayerId = matchWinner?.id ?? null; room.activeRound = null; store.bump(room);
    io.to(room.id).emit('round:ended', { roomId: room.id, roundId: round.id, winnerPlayerId, reason, answer: publicGame(answer), stateVersion: room.revision }); emitSnapshots(room);
    if (matchWinner) { try { record(room); } catch (error) { console.error('Unable to persist multiplayer match', error); } io.to(room.id).emit('match:ended', { roomId: room.id, winnerPlayerId: matchWinner.id, scores: room.match.scores }); }
    else {
      const transition = setTimeout(() => withRoomLock(room.id, () => {
        transitionTimers.delete(room.id);
        if (room.status !== 'round_over') return;
        room.status = 'countdown'; room.countdownEndsAt = now() + countdownMs; store.bump(room); emitSnapshots(room); scheduleCountdown(room);
      }), nextRoundDelayMs);
      transition.unref(); transitionTimers.set(room.id, transition);
    }
  }
  const engine = createMatchEngine({ catalog, random, now, onRoundEnd: endRound });

  function forfeitPlayer(room, playerId, reason) {
    const state = room.activeRound?.players[playerId];
    if (!state || state.finished) return;
    state.finished = true;
    const contenders = room.players.filter(player => player.id !== playerId && player.connected && !room.activeRound.players[player.id]?.finished);
    if (contenders.length === 1) endRound(room, contenders[0].id, reason);
    else if (Object.values(room.activeRound.players).every(value => value.finished)) endRound(room, null, reason);
  }

  function register(socket, event, schema, handler) {
    socket.on(event, async (payload, ack = () => {}) => {
      const parsed = schema.safeParse(payload); if (!parsed.success) return ack(fail('INVALID_PAYLOAD', 'Invalid request payload.'));
      try { await handler(parsed.data, ack); } catch (error) { console.error(`multiplayer ${event}`, error); ack(fail('INTERNAL_ERROR', 'Server could not process the request.')); }
    });
  }

  io.on('connection', socket => {
    register(socket, 'room:create', createSchema, async (data, ack) => {
      const settings = { ...DEFAULT_SETTINGS, ...data.settings }; const created = store.create({ playerId: data.playerId, displayName: data.displayName, settings, pool: difficultyPool(catalog, settings.difficulty) }); bind(created.room, created.player, socket);
      ack(ok({ room: view(created.room, created.player.id), playerId: created.player.id, resumeToken: created.resumeToken }, created.room.revision));
    });
    register(socket, 'room:join', joinSchema, async (data, ack) => {
      const room = store.findByCode(data.roomCode); if (!room) return ack(fail('ROOM_NOT_FOUND', 'Room not found.'));
      await withRoomLock(room.id, () => { const result = store.addPlayer(room, data.playerId, data.displayName); if (result.error) return ack(fail(...result.error)); bind(room, result.player, socket); ack(ok({ room: view(room, result.player.id), playerId: result.player.id, resumeToken: result.resumeToken }, room.revision)); emitSnapshots(room); });
    });
    register(socket, 'room:resume', resumeSchema, async (data, ack) => {
      const room = store.findByCode(data.roomCode); const player = room && store.resume(room, data.playerId, data.resumeToken); if (!room || !player) return ack(fail('RESUME_TOKEN_INVALID', 'Unable to resume this room.'));
      await withRoomLock(room.id, () => { player.reconnectCount = (player.reconnectCount ?? 0) + 1; bind(room, player, socket); store.bump(room); ack(ok({ room: view(room, player.id) }, room.revision)); emitSnapshots(room); });
    });
    register(socket, 'room:leave', roomSchema, async (data, ack) => {
      const room = store.findById(data.roomId); const player = room && playerForSocket(room, socket); if (!room || !player) return ack(fail('NOT_ROOM_MEMBER', 'You are not in this room.'));
      await withRoomLock(room.id, () => { clearTimeout(transitionTimers.get(room.id)); transitionTimers.delete(room.id); if (room.status === 'playing') forfeitPlayer(room, player.id, 'player_left'); room.players = room.players.filter(value => value.id !== player.id); socket.leave(room.id); socket.data.roomId = null; socket.data.playerId = null; if (room.players.length === 0) store.delete(room.id); else { if (room.hostPlayerId === player.id) room.hostPlayerId = room.players[0].id; store.bump(room); emitSnapshots(room); } ack(ok({})); });
    });
    register(socket, 'lobby:set-ready', readySchema, async (data, ack) => {
      const room = store.findById(data.roomId); const player = room && playerForSocket(room, socket); if (!room || !player) return ack(fail('NOT_ROOM_MEMBER', 'You are not in this room.'));
      await withRoomLock(room.id, () => { if (room.status !== 'lobby') return ack(fail('INVALID_ROOM_STATE', 'Readiness can only change in the lobby.')); player.ready = data.ready; store.bump(room); ack(ok({}, room.revision)); emitSnapshots(room); });
    });
    register(socket, 'lobby:update-settings', settingsUpdateSchema, async (data, ack) => {
      const room = store.findById(data.roomId); const player = room && playerForSocket(room, socket); if (!room || !player) return ack(fail('NOT_ROOM_MEMBER', 'You are not in this room.'));
      await withRoomLock(room.id, () => { if (room.hostPlayerId !== player.id) return ack(fail('NOT_HOST', 'Only the host can change settings.')); if (room.status !== 'lobby' || room.revision !== data.expectedVersion) return ack(fail('INVALID_ROOM_STATE', 'Room settings are stale or locked.')); if (data.settings.maxPlayers < room.players.length) return ack(fail('INVALID_SETTINGS', 'Maximum players cannot be lower than the current player count.')); room.settings = data.settings; room.pool = difficultyPool(catalog, data.settings.difficulty); store.bump(room); ack(ok({}, room.revision)); emitSnapshots(room); });
    });
    register(socket, 'match:start', roomSchema, async (data, ack) => {
      const room = store.findById(data.roomId); const player = room && playerForSocket(room, socket); if (!room || !player) return ack(fail('NOT_ROOM_MEMBER', 'You are not in this room.'));
      await withRoomLock(room.id, () => {
        if (room.hostPlayerId !== player.id) return ack(fail('NOT_HOST', 'Only the host can start.'));
        if (room.status !== 'lobby' || room.players.length < 2 || room.players.length > room.settings.maxPlayers || room.players.some(value => !value.ready)) return ack(fail('INVALID_ROOM_STATE', 'At least two players must be ready.'));
        room.match = { id: `match_${randomUUID()}`, roundNumber: 0, scores: Object.fromEntries(room.players.map(value => [value.id, 0])), winnerPlayerId: null, startedAt: now(), rounds: [] };
        room.status = 'countdown'; room.countdownEndsAt = now() + countdownMs; store.bump(room); scheduleCountdown(room); emitSnapshots(room); ack(ok({}, room.revision));
      });
    });
    register(socket, 'round:guess', guessSchema, async (data, ack) => {
      const room = store.findById(data.roomId); const player = room && playerForSocket(room, socket); if (!room || !player) return ack(fail('NOT_ROOM_MEMBER', 'You are not in this room.'));
      await withRoomLock(room.id, () => {
        const cacheKey = `${player.id}:${data.commandId}`;
        const cached = room.commandResults.get(cacheKey);
        if (cached) return ack(cached);
        if (!allowGuess(player.id)) return ack(fail('GUESS_RATE_LIMITED', 'Too many guesses. Please slow down.'));
        if (room.status !== 'playing' || room.activeRound?.id !== data.roundId) return ack(fail('ROUND_STALE', 'This round is no longer active.'));
        if (room.activeRound.endsAt <= now()) { endRound(room, null, 'timeout'); return ack(fail('ROUND_STALE', 'This round has ended.')); }
        const result = engine.guess(room, player.id, data.guessAppId); if (result.error) return ack(fail(...result.error));
        const visible = new Set(room.settings.visibleFields);
        result.feedback.fields = result.feedback.fields.filter(field => visible.has(field.fieldName));
        if (!visible.has('tags')) result.feedback.matchingTags = [];
        if (!visible.has('companies')) result.feedback.matchingCompanies = [];
        store.bump(room); const response = ok(result, room.revision); room.commandResults.set(cacheKey, response); if (room.commandResults.size > 200) room.commandResults.delete(room.commandResults.keys().next().value);
        socket.emit('round:guess-result', { roomId: room.id, roundId: data.roundId, guessAppId: data.guessAppId, ...result, stateVersion: room.revision }); ack(response); emitSnapshots(room);
      });
    });
    register(socket, 'round:surrender', surrenderSchema, async (data, ack) => {
      const room = store.findById(data.roomId); const player = room && playerForSocket(room, socket); if (!room || !player) return ack(fail('NOT_ROOM_MEMBER', 'You are not in this room.'));
      await withRoomLock(room.id, () => { if (room.status !== 'playing' || room.activeRound?.id !== data.roundId) return ack(fail('ROUND_STALE', 'This round is no longer active.')); forfeitPlayer(room, player.id, 'surrender'); store.bump(room); emitSnapshots(room); ack(ok({}, room.revision)); });
    });
    register(socket, 'match:rematch', rematchSchema, async (data, ack) => {
      const room = store.findById(data.roomId); const player = room && playerForSocket(room, socket); if (!room || !player) return ack(fail('NOT_ROOM_MEMBER', 'You are not in this room.'));
      await withRoomLock(room.id, () => { if (room.status !== 'finished') return ack(fail('INVALID_ROOM_STATE', 'The match is not finished.')); player.rematch = data.accept; if (room.players.every(value => value.rematch)) { room.status = 'lobby'; room.match = null; for (const value of room.players) { value.ready = false; value.rematch = false; } } store.bump(room); ack(ok({}, room.revision)); emitSnapshots(room); });
    });
    socket.on('disconnect', () => { const room = store.findById(socket.data.roomId); const player = room && store.findPlayer(room, socket.data.playerId); if (!room || !player || player.socketId !== socket.id) return; void withRoomLock(room.id, () => { player.connected = false; player.socketId = null; store.bump(room); emitSnapshots(room); if (room.status === 'playing') { const timer = setTimeout(() => void withRoomLock(room.id, () => { if (room.status === 'playing' && !player.connected) { forfeitPlayer(room, player.id, 'disconnect_timeout'); } }), disconnectGraceMs); timer.unref(); disconnectTimers.set(player.id, timer); } }); });
  });

  const reconcile = setInterval(() => {
    for (const room of store.rooms.values()) void withRoomLock(room.id, () => {
      if (room.status === 'countdown' && room.countdownEndsAt <= now()) startRound(room);
      else if (room.status === 'playing' && room.activeRound?.endsAt <= now()) endRound(room, null, 'timeout');
    });
  }, 5_000);
  reconcile.unref();
  const cleanup = setInterval(() => { store.cleanup(); const cutoff = now() - 60_000; for (const [key, value] of guessLimits) if (value.startedAt < cutoff) guessLimits.delete(key); }, 60_000); cleanup.unref();
  return { io, health: () => ({ status: 'ok', rooms: store.rooms.size, connections: io.engine.clientsCount }), close: async () => { clearInterval(reconcile); clearInterval(cleanup); for (const timer of timers.values()) clearTimeout(timer); for (const timer of transitionTimers.values()) clearTimeout(timer); for (const timer of disconnectTimers.values()) clearTimeout(timer); await io.close(); database?.close(); } };
}
