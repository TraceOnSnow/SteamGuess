import { resolve } from 'node:path';
import { openDatabase, insertDifficultyFeedback, upsertSession } from './database.js';

const LEVELS = new Set(['easy', 'normal', 'hard', 'hell']);
const OUTCOMES = new Set(['won', 'lost', 'surrendered']);
const MODES = new Set(['difficulty', 'library']);

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

function extractProfile(value) {
  const trimmed = value.trim();
  if (/^\d{17}$/.test(trimmed)) return { steamId: trimmed };
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://steamcommunity.com/${trimmed.replace(/^\/+/, '')}`);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'profiles' && /^\d{17}$/.test(parts[1] ?? '')) return { steamId: parts[1] };
    if (parts[0] === 'id' && parts[1]) return { vanity: parts[1] };
  } catch {
    // A plain vanity name is handled below.
  }
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? { vanity: trimmed } : {};
}

async function steamJson(path, params) {
  const url = new URL(`https://api.steampowered.com/${path}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, {
    headers: { 'User-Agent': 'SteamGuess server/1.0' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new HttpError(502, `Steam Web API returned ${response.status}`);
  return response.json();
}

function clientAddress(request, trustProxy) {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
    if (first?.trim()) return first.trim();
  }
  return request.socket?.remoteAddress || 'unknown';
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
  steamApiKey = '',
  trustProxy = false,
  writeRateLimit = 60,
  profileRateLimit = 12,
  rateLimitWindowMs = 60_000,
  health = () => ({}),
} = {}) {
  let db;
  const database = () => db ??= openDatabase(dbPath ?? resolve(rootDir, 'data/runtime/steamguess.sqlite'));
  const writeLimiter = createRateLimiter({ limit: writeRateLimit, windowMs: rateLimitWindowMs });
  const profileLimiter = createRateLimiter({ limit: profileRateLimit, windowMs: rateLimitWindowMs });

  const apiHandler = async function apiHandler(request, response, next) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (next) return next();
      return json(response, 404, { error: 'Not found.' });
    }

    try {
      const address = clientAddress(request, trustProxy);
      if (request.method === 'GET' && url.pathname === '/api/steam-library') {
        if (!applyLimit(response, profileLimiter.consume(address))) return;
      } else if (request.method === 'POST') {
        if (!applyLimit(response, writeLimiter.consume(address))) return;
      }

      if (request.method === 'GET' && url.pathname === '/api/health') {
        database();
        return json(response, 200, { ok: true, multiplayer: health() });
      }

      if (request.method === 'GET' && url.pathname === '/api/steam-library') {
        if (!steamApiKey) return json(response, 503, { error: 'STEAM_WEB_API_KEY is not configured.' });
        const parsed = extractProfile(url.searchParams.get('profile') ?? '');
        let steamId = parsed.steamId;
        if (!steamId && parsed.vanity) {
          const resolved = await steamJson('ISteamUser/ResolveVanityURL/v0001/', { key: steamApiKey, vanityurl: parsed.vanity });
          if (resolved.response?.success !== 1 || !resolved.response.steamid) throw new HttpError(404, 'Steam profile was not found.');
          steamId = resolved.response.steamid;
        }
        if (!steamId) throw new HttpError(400, 'Enter a SteamID64 or a Steam Community profile URL.');
        const [owned, summary] = await Promise.all([
          steamJson('IPlayerService/GetOwnedGames/v0001/', {
            key: steamApiKey,
            steamid: steamId,
            include_appinfo: 'false',
            include_played_free_games: 'true',
            format: 'json',
          }),
          steamJson('ISteamUser/GetPlayerSummaries/v0002/', { key: steamApiKey, steamids: steamId }),
        ]);
        const games = owned.response?.games;
        if (!Array.isArray(games)) throw new HttpError(404, 'The Steam profile game details are private or unavailable.');
        return json(response, 200, {
          steamId,
          profileName: summary.response?.players?.[0]?.personaname,
          appIds: games.map(game => Number(game.appid)).filter(Number.isSafeInteger),
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/sessions/complete') {
        const body = await readJson(request);
        if (!validId(body.sessionId) || !validId(body.playerId) || !validAppId(body.answerAppId)) {
          return json(response, 400, { error: 'Invalid session payload.' });
        }
        if (!MODES.has(body.mode) || !OUTCOMES.has(body.outcome)) return json(response, 400, { error: 'Invalid session mode or outcome.' });
        upsertSession(database(), {
          id: body.sessionId,
          playerId: body.playerId,
          mode: body.mode,
          difficulty: LEVELS.has(body.difficulty) ? body.difficulty : null,
          answerAppId: body.answerAppId,
          outcome: body.outcome,
          guesses: Math.max(0, Math.min(100, Number(body.guesses) || 0)),
          hintsUsed: Math.max(0, Math.min(10, Number(body.hintsUsed) || 0)),
          startedAt: typeof body.startedAt === 'string' ? body.startedAt : new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        });
        return json(response, 201, { ok: true });
      }

      if (request.method === 'POST' && url.pathname === '/api/feedback/difficulty') {
        const body = await readJson(request);
        const score = Number(body.score);
        if (!validId(body.playerId) || !validAppId(body.appId) || !Number.isFinite(score) || score < 0 || score > 100 || !LEVELS.has(body.level)) {
          return json(response, 400, { error: 'Invalid difficulty feedback.' });
        }
        const id = insertDifficultyFeedback(database(), {
          playerId: body.playerId,
          sessionId: validId(body.sessionId) ? body.sessionId : null,
          appId: body.appId,
          score,
          level: body.level,
          reason: 'difficulty_unreasonable',
        });
        return json(response, 201, { ok: true, id });
      }

      return json(response, 404, { error: 'API endpoint not found.' });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
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

export const testHelpers = { extractProfile, clientAddress };
