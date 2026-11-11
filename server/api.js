import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase, saveAnswerFeedback, upsertSession } from './database.js';
import { LEVELS as LEVEL_LIST } from '../shared/game-rules.js';

const LEVELS = new Set(LEVEL_LIST);
const OUTCOMES = new Set(['won', 'lost', 'surrendered']);
const MODES = new Set(['daily', 'practice', 'preset']);
const VERDICTS = new Set(['fair', 'obscure']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(response, status, payload) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(JSON.stringify(payload));
}

async function readJson(request, limit = 32_768) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value);
}

function validAppId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function clientAddress(request, trustProxy) {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
    if (first?.trim()) return first.trim();
  }
  return request.socket?.remoteAddress || 'unknown';
}

/** The published snapshot is the only catalog; it is re-read when the file changes. */
function createCatalogReader(rootDir) {
  let cached = null;
  return () => {
    // Local development must not be shadowed by a stale build artifact.
    // Production images only contain dist, so the same order is safe there.
    const candidates = [resolve(rootDir, 'public/games_demo.json'), resolve(rootDir, 'dist/games_demo.json')];
    const path = candidates.find(existsSync);
    if (!path) throw new HttpError(503, 'Published game catalog is unavailable.');
    const stat = statSync(path);
    if (!cached || cached.path !== path || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
      const payload = JSON.parse(readFileSync(path, 'utf8'));
      cached = { path, mtimeMs: stat.mtimeMs, size: stat.size, games: Array.isArray(payload) ? payload : Object.values(payload) };
    }
    return cached.games;
  };
}

export function createRateLimiter({ limit, windowMs }) {
  const entries = new Map();
  return {
    consume(key, now = Date.now()) {
      if (limit <= 0) return { allowed: true, limit: 0, remaining: 0, resetAt: now };
      const previous = entries.get(key);
      const entry = !previous || previous.resetAt <= now
        ? { count: 0, resetAt: now + windowMs }
        : previous;
      entry.count += 1;
      entries.set(key, entry);
      if (entries.size > 10_000) {
        for (const [storedKey, stored] of entries) if (stored.resetAt <= now) entries.delete(storedKey);
      }
      return {
        allowed: entry.count <= limit,
        limit,
        remaining: Math.max(0, limit - entry.count),
        resetAt: entry.resetAt,
      };
    },
  };
}

function applyLimit(response, result) {
  if (result.limit > 0) {
    response.setHeader('RateLimit-Limit', String(result.limit));
    response.setHeader('RateLimit-Remaining', String(result.remaining));
    response.setHeader('RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
  }
  if (result.allowed) return true;
  response.setHeader('Retry-After', String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))));
  json(response, 429, { error: 'Too many requests. Please try again later.' });
  return false;
}

export function createApiHandler({
  rootDir = process.cwd(),
  dbPath,
  trustProxy = false,
  writeRateLimit = 60,
  rateLimitWindowMs = 60_000,
  health = () => ({}),
} = {}) {
  let db;
  const database = () => db ??= openDatabase(dbPath ?? resolve(rootDir, 'data/runtime/steamguess.sqlite'));
  const readCatalog = createCatalogReader(rootDir);
  const writeLimiter = createRateLimiter({ limit: writeRateLimit, windowMs: rateLimitWindowMs });

  const apiHandler = async function apiHandler(request, response, next) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (next) return next();
      return json(response, 404, { error: 'Not found.' });
    }

    try {
      if (request.method === 'GET' && url.pathname === '/api/catalog/games') {
        return json(response, 200, readCatalog());
      }

      if (request.method === 'GET' && url.pathname === '/api/health') {
        database();
        return json(response, 200, { ok: true, multiplayer: health() });
      }

      if (request.method === 'POST' && !applyLimit(response, writeLimiter.consume(clientAddress(request, trustProxy)))) return;

      if (request.method === 'POST' && url.pathname === '/api/sessions/complete') {
        const body = await readJson(request);
        if (!validId(body.sessionId) || !validId(body.playerId) || !validAppId(body.answerAppId)) {
          return json(response, 400, { error: 'Invalid session payload.' });
        }
        if (!MODES.has(body.mode) || !OUTCOMES.has(body.outcome) || !LEVELS.has(body.difficulty)) {
          return json(response, 400, { error: 'Invalid session mode, difficulty or outcome.' });
        }
        upsertSession(database(), {
          id: body.sessionId,
          playerId: body.playerId,
          mode: body.mode,
          difficulty: body.difficulty,
          answerAppId: body.answerAppId,
          outcome: body.outcome,
          guesses: Math.max(0, Math.min(100, Number(body.guesses) || 0)),
          hintsUsed: Math.max(0, Math.min(10, Number(body.hintsUsed) || 0)),
          startedAt: typeof body.startedAt === 'string' ? body.startedAt : new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        });
        return json(response, 201, { ok: true });
      }

      if (request.method === 'POST' && url.pathname === '/api/feedback/answer') {
        const body = await readJson(request);
        if (!validId(body.sessionId) || !validId(body.playerId) || !validAppId(body.appId) || !VERDICTS.has(body.verdict)) {
          return json(response, 400, { error: 'Invalid feedback.' });
        }
        try {
          saveAnswerFeedback(database(), { sessionId: body.sessionId, playerId: body.playerId, appId: body.appId, verdict: body.verdict });
        } catch (error) {
          return json(response, 409, { error: error instanceof Error ? error.message : 'Feedback was rejected.' });
        }
        return json(response, 201, { ok: true });
      }

      return json(response, 404, { error: 'API endpoint not found.' });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : Number(error?.status) || 500;
      if (status >= 500) console.error(error);
      return json(response, status, { error: error instanceof Error ? error.message : 'Internal server error.' });
    }
  };

  apiHandler.close = () => {
    db?.close();
    db = undefined;
  };
  return apiHandler;
}

export const testHelpers = { clientAddress };
