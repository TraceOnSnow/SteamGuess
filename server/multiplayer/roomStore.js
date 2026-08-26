import { createHash, randomBytes, randomUUID } from 'node:crypto';

const ROOM_TTL = 30 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;
const RENEW_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;
const COMMIT_ROOM_SCRIPT = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call("SET", KEYS[2], ARGV[2], "PX", ARGV[3])
redis.call("SET", KEYS[3], ARGV[4], "PX", ARGV[3])
redis.call("SADD", KEYS[4], ARGV[4])
return 1
`;
const DELETE_ROOM_SCRIPT = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call("DEL", KEYS[2])
redis.call("DEL", KEYS[3])
redis.call("SREM", KEYS[4], ARGV[2])
return 1
`;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function roomCode() {
  return Array.from(randomBytes(5), byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

function token() {
  return randomBytes(32).toString('base64url');
}

function tokenHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function createRoom({ playerId, displayName, settings, pool, socketId, now }) {
  const resumeToken = token();
  const room = {
    id: `room_${randomUUID()}`,
    code: roomCode(),
    status: 'lobby',
    revision: 1,
    hostPlayerId: playerId,
    settings,
    pool,
    players: [{
      id: playerId,
      displayName,
      ready: false,
      socketId: socketId ?? null,
      tokenHash: tokenHash(resumeToken),
      connected: Boolean(socketId),
      disconnectExpiresAt: null,
    }],
    match: null,
    activeRound: null,
    nextRoundStartsAt: null,
    createdAt: now(),
    updatedAt: now(),
    expiresAt: now() + ROOM_TTL,
    commandResults: new Map(),
  };
  return { room, player: room.players[0], resumeToken };
}

function encodeRoom(room) {
  return JSON.stringify({
    ...room,
    commandResults: [...room.commandResults.entries()],
  });
}

function decodeRoom(value) {
  if (!value) return null;
  const room = JSON.parse(value);
  room.commandResults = new Map(Array.isArray(room.commandResults) ? room.commandResults : []);
  return room;
}

class RoomStoreBase {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
  }

  addPlayer(room, playerId, displayName) {
    if (room.players.length >= room.settings.maxPlayers) {
      return { error: ['ROOM_FULL', `This room is full (${room.settings.maxPlayers} players maximum).`] };
    }
    if (room.players.some(player => player.id === playerId)) {
      return { error: ['PLAYER_ALREADY_JOINED', 'This player is already in the room.'] };
    }
    const resumeToken = token();
    const player = {
      id: playerId,
      displayName,
      ready: false,
      socketId: null,
      tokenHash: tokenHash(resumeToken),
      connected: false,
      disconnectExpiresAt: null,
    };
    room.players.push(player);
    this.bump(room);
    return { player, resumeToken };
  }

  findPlayer(room, id) {
    return room.players.find(player => player.id === id);
  }

  resume(room, playerId, resumeToken) {
    const player = this.findPlayer(room, playerId);
    return player && player.tokenHash === tokenHash(resumeToken) ? player : null;
  }

  bump(room) {
    room.revision += 1;
    room.updatedAt = this.now();
    room.expiresAt = this.now() + ROOM_TTL;
  }
}

export class MemoryRoomStore extends RoomStoreBase {
  constructor(options = {}) {
    super(options);
    this.kind = 'memory';
    this.rooms = new Map();
    this.locks = new Map();
  }

  async create(options) {
    let created;
    do created = createRoom({ ...options, now: this.now });
    while ([...this.rooms.values()].some(room => room.code === created.room.code));
    this.rooms.set(created.room.id, created.room);
    return created;
  }

  async findById(id) {
    return this.rooms.get(id) ?? null;
  }

  async findByCode(code) {
    return [...this.rooms.values()].find(room => room.code === code) ?? null;
  }

  async mutate(id, action) {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const room = this.rooms.get(id);
      if (!room) return { room: null, value: null, found: false };
      let shouldDelete = false;
      const value = await action(room, { deleteRoom: () => { shouldDelete = true; } });
      if (shouldDelete) this.rooms.delete(id);
      return { room: shouldDelete ? null : room, value, found: true };
    });
    const tracked = operation.finally(() => {
      if (this.locks.get(id) === tracked) this.locks.delete(id);
    });
    this.locks.set(id, tracked);
    return tracked;
  }

  async listRooms() {
    return [...this.rooms.values()];
  }

  cleanup() {
    for (const [id, room] of this.rooms) {
      if (room.expiresAt < this.now()) this.rooms.delete(id);
    }
  }

  get roomCount() {
    return this.rooms.size;
  }

  async close() {}
}

export class RedisRoomStore extends RoomStoreBase {
  constructor({
    client,
    prefix = 'steamguess:multiplayer',
    now = () => Date.now(),
    lockTtlMs = 10_000,
    lockWaitMs = 5_000,
  }) {
    super({ now });
    this.kind = 'redis';
    this.client = client;
    this.prefix = prefix.replace(/:+$/, '');
    this.lockTtlMs = lockTtlMs;
    this.lockWaitMs = lockWaitMs;
    this.cachedRoomCount = 0;
  }

  roomKey(id) {
    return `${this.prefix}:room:${id}`;
  }

  codeKey(code) {
    return `${this.prefix}:code:${code}`;
  }

  lockKey(id) {
    return `${this.prefix}:lock:${id}`;
  }

  get indexKey() {
    return `${this.prefix}:rooms`;
  }

  async create(options) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const created = createRoom({ ...options, now: this.now });
      const ttl = Math.max(1, created.room.expiresAt - this.now());
      const reserved = await this.client.set(this.codeKey(created.room.code), created.room.id, { NX: true, PX: ttl });
      if (!reserved) continue;
      try {
        await this.client.multi()
          .set(this.roomKey(created.room.id), encodeRoom(created.room), { PX: ttl })
          .sAdd(this.indexKey, created.room.id)
          .exec();
        this.cachedRoomCount += 1;
        return created;
      } catch (error) {
        await this.client.del(this.codeKey(created.room.code));
        throw error;
      }
    }
    throw new Error('Unable to allocate a unique multiplayer room code.');
  }

  async findById(id) {
    return decodeRoom(await this.client.get(this.roomKey(id)));
  }

  async findByCode(code) {
    const id = await this.client.get(this.codeKey(code));
    if (!id) return null;
    const room = await this.findById(id);
    if (!room) await this.client.del(this.codeKey(code));
    return room;
  }

  async acquireLock(id) {
    const lockKey = this.lockKey(id);
    const lockToken = token();
    const deadline = this.now() + this.lockWaitMs;
    while (this.now() < deadline) {
      const acquired = await this.client.set(lockKey, lockToken, { NX: true, PX: this.lockTtlMs });
      if (acquired) return { lockKey, lockToken };
      await delay(15 + Math.floor(Math.random() * 25));
    }
    throw new Error(`Timed out waiting for multiplayer room lock: ${id}`);
  }

  async mutate(id, action) {
    const { lockKey, lockToken } = await this.acquireLock(id);
    const renew = setInterval(() => {
      void this.client.eval(RENEW_LOCK_SCRIPT, {
        keys: [lockKey],
        arguments: [lockToken, String(this.lockTtlMs)],
      }).catch(() => {});
    }, Math.max(25, Math.floor(this.lockTtlMs / 3)));
    renew.unref();

    try {
      const room = await this.findById(id);
      if (!room) return { room: null, value: null, found: false };
      let shouldDelete = false;
      const value = await action(room, { deleteRoom: () => { shouldDelete = true; } });
      if (shouldDelete) {
        const deleted = await this.client.eval(DELETE_ROOM_SCRIPT, {
          keys: [
            lockKey,
            this.roomKey(room.id),
            this.codeKey(room.code),
            this.indexKey,
          ],
          arguments: [lockToken, room.id],
        });
        if (deleted !== 1) {
          throw new Error(`Lost multiplayer room lock before deleting room: ${room.id}`);
        }
        this.cachedRoomCount = Math.max(0, this.cachedRoomCount - 1);
        return { room: null, value, found: true };
      }
      const ttl = Math.max(1, room.expiresAt - this.now());
      const committed = await this.client.eval(COMMIT_ROOM_SCRIPT, {
        keys: [
          lockKey,
          this.roomKey(room.id),
          this.codeKey(room.code),
          this.indexKey,
        ],
        arguments: [lockToken, encodeRoom(room), String(ttl), room.id],
      });
      if (committed !== 1) {
        throw new Error(`Lost multiplayer room lock before committing room: ${room.id}`);
      }
      return { room, value, found: true };
    } finally {
      clearInterval(renew);
      await this.client.eval(RELEASE_LOCK_SCRIPT, {
        keys: [lockKey],
        arguments: [lockToken],
      }).catch(() => {});
    }
  }

  async listRooms() {
    const ids = await this.client.sMembers(this.indexKey);
    if (ids.length === 0) {
      this.cachedRoomCount = 0;
      return [];
    }
    const values = await this.client.mGet(ids.map(id => this.roomKey(id)));
    const rooms = [];
    const stale = [];
    for (let index = 0; index < ids.length; index += 1) {
      const room = decodeRoom(values[index]);
      if (room) rooms.push(room);
      else stale.push(ids[index]);
    }
    if (stale.length) await this.client.sRem(this.indexKey, stale);
    this.cachedRoomCount = rooms.length;
    return rooms;
  }

  async cleanup() {
    await this.listRooms();
  }

  get roomCount() {
    return this.cachedRoomCount;
  }

  async close() {}
}
