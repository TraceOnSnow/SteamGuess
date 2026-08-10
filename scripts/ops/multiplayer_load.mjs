import { io } from 'socket.io-client';

const baseUrl = process.env.STEAMGUESS_URL || 'http://127.0.0.1:4173';
const roomCount = Math.max(1, Number(process.env.ROOMS || 10));
const clients = [];
const startedAt = performance.now();
function emit(socket, event, payload) { return new Promise((resolve, reject) => socket.timeout(5000).emit(event, payload, (error, response) => error ? reject(error) : resolve(response))); }
function connect() { return new Promise((resolve, reject) => { const socket = io(baseUrl, { transports: ['websocket'], forceNew: true }); const timer = setTimeout(() => reject(new Error('Connection timeout')), 5000); socket.once('connect', () => { clearTimeout(timer); clients.push(socket); resolve(socket); }); socket.once('connect_error', reject); }); }
function id(prefix, index) { return `${prefix}_${index}_${crypto.randomUUID()}`; }

try {
  await Promise.all(Array.from({ length: roomCount }, async (_, index) => {
    const [host, guest] = await Promise.all([connect(), connect()]);
    const created = await emit(host, 'room:create', { playerId: id('player_load_host', index), displayName: `Host ${index}`, settings: { difficulty: 'normal', bestOf: 1, roundTimeSeconds: 120 }, commandId: id('command_create', index) });
    if (!created.ok) throw new Error(created.error.message);
    const joined = await emit(guest, 'room:join', { playerId: id('player_load_guest', index), roomCode: created.data.room.code, displayName: `Guest ${index}`, commandId: id('command_join', index) });
    if (!joined.ok) throw new Error(joined.error.message);
    await Promise.all([
      emit(host, 'lobby:set-ready', { roomId: created.data.room.id, ready: true, commandId: id('command_ready_host', index) }),
      emit(guest, 'lobby:set-ready', { roomId: created.data.room.id, ready: true, commandId: id('command_ready_guest', index) }),
    ]);
    const result = await emit(host, 'match:start', { roomId: created.data.room.id, commandId: id('command_start', index) });
    if (!result.ok) throw new Error(result.error.message);
    await emit(host, 'room:leave', { roomId: created.data.room.id, commandId: id('command_leave_host', index) });
    await emit(guest, 'room:leave', { roomId: created.data.room.id, commandId: id('command_leave_guest', index) });
  }));
  console.log(JSON.stringify({ ok: true, rooms: roomCount, clients: clients.length, elapsedMs: Math.round(performance.now() - startedAt) }));
} finally {
  for (const client of clients) client.close();
}
