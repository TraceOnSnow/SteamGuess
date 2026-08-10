import { randomBytes, randomUUID, createHash } from 'node:crypto';

const ROOM_TTL = 30 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function roomCode() { return Array.from(randomBytes(5), byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join(''); }
function token() { return randomBytes(32).toString('base64url'); }
function tokenHash(value) { return createHash('sha256').update(value).digest('hex'); }

export class MemoryRoomStore {
  constructor({ now = () => Date.now() } = {}) { this.rooms = new Map(); this.now = now; }
  create({ playerId, displayName, settings, pool }) {
    let code; do code = roomCode(); while ([...this.rooms.values()].some(room => room.code === code));
    const id = `room_${randomUUID()}`; const resumeToken = token();
    const room = { id, code, status: 'lobby', revision: 1, hostPlayerId: playerId, settings, pool, players: [{ id: playerId, displayName, ready: false, socketId: null, tokenHash: tokenHash(resumeToken), connected: false }], match: null, activeRound: null, createdAt: this.now(), updatedAt: this.now(), expiresAt: this.now() + ROOM_TTL, commandResults: new Map() };
    this.rooms.set(id, room); return { room, player: room.players[0], resumeToken };
  }
  findById(id) { return this.rooms.get(id); }
  findByCode(code) { return [...this.rooms.values()].find(room => room.code === code); }
  addPlayer(room, playerId, displayName) {
    if (room.players.length >= room.settings.maxPlayers) return { error: ['ROOM_FULL', `This room is full (${room.settings.maxPlayers} players maximum).`] };
    if (room.players.some(player => player.id === playerId)) return { error: ['PLAYER_ALREADY_JOINED', 'This player is already in the room.'] };
    const resumeToken = token();
    const player = { id: playerId, displayName, ready: false, socketId: null, tokenHash: tokenHash(resumeToken), connected: false };
    room.players.push(player); room.updatedAt = this.now(); room.revision += 1; return { player, resumeToken };
  }
  findPlayer(room, id) { return room.players.find(player => player.id === id); }
  resume(room, playerId, resumeToken) { const player = this.findPlayer(room, playerId); return player && player.tokenHash === tokenHash(resumeToken) ? player : null; }
  bump(room) { room.revision += 1; room.updatedAt = this.now(); room.expiresAt = this.now() + ROOM_TTL; }
  delete(id) { this.rooms.delete(id); }
  cleanup() { for (const [id, room] of this.rooms) if (room.expiresAt < this.now()) this.rooms.delete(id); }
}
