import { z } from 'zod';

export const commandSchema = z.object({ commandId: z.string().min(8).max(100) });
export const visibleFieldSchema = z.enum(['price', 'popularity', 'reviews', 'rating', 'releaseDate', 'companies', 'tags']);
export const settingsSchema = z.object({
  difficulty: z.enum(['easy', 'normal', 'hard', 'hell']).default('normal'),
  bestOf: z.union([z.literal(1), z.literal(3), z.literal(5)]).default(1),
  maxPlayers: z.number().int().min(2).max(8).default(4),
  roundTimeSeconds: z.number().int().min(30).max(600).default(120),
  visibleFields: z.array(visibleFieldSchema).min(1).max(7).default(['price', 'popularity', 'reviews', 'rating', 'releaseDate', 'companies', 'tags']),
}).strict();
const playerIdSchema = z.string().regex(/^player_[A-Za-z0-9_-]{8,90}$/);
export const createSchema = commandSchema.extend({ playerId: playerIdSchema, displayName: z.string().trim().min(1).max(32), settings: settingsSchema.optional() });
export const joinSchema = commandSchema.extend({ playerId: playerIdSchema, roomCode: z.string().regex(/^[A-Z0-9]{4,8}$/), displayName: z.string().trim().min(1).max(32) });
export const resumeSchema = z.object({ roomCode: z.string().regex(/^[A-Z0-9]{4,8}$/), playerId: z.string().min(8).max(100), resumeToken: z.string().min(20).max(200) });
export const roomSchema = commandSchema.extend({ roomId: z.string().min(8).max(100) });
export const readySchema = roomSchema.extend({ ready: z.boolean() });
export const settingsUpdateSchema = roomSchema.extend({ settings: settingsSchema, expectedVersion: z.number().int().nonnegative() });
export const guessSchema = roomSchema.extend({ roundId: z.string().min(8).max(100), guessAppId: z.number().int().positive() });
export const surrenderSchema = roomSchema.extend({ roundId: z.string().min(8).max(100) });
export const rematchSchema = roomSchema.extend({ accept: z.boolean() });

export function ok(data, stateVersion) { return { ok: true, data, ...(stateVersion === undefined ? {} : { stateVersion }) }; }
export function fail(code, message) { return { ok: false, error: { code, message } }; }
