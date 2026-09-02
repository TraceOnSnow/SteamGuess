import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const LEVELS = ['beginner', 'easy', 'normal', 'hard', 'hell'];
const EXCLUDED_REASONS = ['software', 'test_app', 'manual_exclusion', 'duplicate'];
const SEARCH_ONLY_REASONS = ['too_obscure'];

function levelForScore(score) {
  if (score < 15) return 'beginner';
  if (score < 25) return 'easy';
  if (score < 50) return 'normal';
  if (score < 75) return 'hard';
  return 'hell';
}

function parseJson(value, fallback = []) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export function openCatalogDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'games'").get();
  if (!table) throw new Error('Converged catalog table games is missing; run scripts.catalog.migrate_catalog.');
  return db;
}

function rowPayload(row) {
  if (!row) return null;
  const score = row.difficulty_score == null ? null : Number(row.difficulty_score);
  const manualScore = row.difficulty_manual_score == null ? null : Number(row.difficulty_manual_score);
  const feedbackMean = row.player_feedback_mean == null ? null : Number(row.player_feedback_mean);
  return {
    appId: Number(row.appid),
    name: row.name_en,
    localizedName: row.name_zh || null,
    manualScore,
    locked: Boolean(row.difficulty_locked),
    feedbackScore: feedbackMean,
    feedbackCount: Number(row.player_feedback_count || 0),
    feedbackMean,
    feedbackStddev: row.player_feedback_stddev == null ? null : Number(row.player_feedback_stddev),
    feedbackUpdatedAt: row.player_feedback_updated_at || null,
    effectiveScore: score,
    effectiveLevel: score == null ? null : levelForScore(score),
    effectiveSource: row.difficulty_source || null,
    updatedAt: row.updated_at || null,
    active: row.pool_status !== 'excluded',
    poolStatus: row.pool_status,
    searchOnly: row.pool_status === 'search_only',
    excluded: row.pool_status === 'excluded',
    exclusionReason: row.status_reason || null,
    exclusionUpdatedAt: row.updated_at || null,
    developers: parseJson(row.developers_json),
    publishers: parseJson(row.publishers_json),
    tags: parseJson(row.tags_json),
    coverUrl: row.cover_url || null,
    heatRank: row.heat_rank == null ? null : Number(row.heat_rank),
  };
}

const ROW_SELECT = `
  SELECT *
  FROM games
`;

export function getDifficultyRow(db, appId) {
  return rowPayload(db.prepare(`${ROW_SELECT} WHERE appid = ?`).get(appId));
}

export function listDifficulties(db, options = {}) {
  const query = String(options.query || '').trim();
  const filters = ['all', 'feedback', 'review', 'locked', 'unlocked', 'edited', 'excluded'];
  const filter = filters.includes(options.filter) ? options.filter : 'all';
  const scope = options.scope === 'all' ? 'all' : 'active';
  const sort = ['effective', 'manual', 'feedback', 'difference', 'name'].includes(options.sort) ? options.sort : 'effective';
  const direction = options.direction === 'desc' ? 'DESC' : 'ASC';
  const page = Math.max(1, Number.parseInt(options.page, 10) || 1);
  const pageSize = Math.max(20, Math.min(500, Number.parseInt(options.pageSize, 10) || 100));
  const where = [];
  const parameters = [];
  if (scope === 'active') where.push("pool_status <> 'excluded'");
  if (query) {
    where.push('(name_en LIKE ? COLLATE NOCASE OR name_zh LIKE ? COLLATE NOCASE OR CAST(appid AS TEXT) = ?)');
    parameters.push(`%${query}%`, `%${query}%`, query);
  }
  if (filter === 'feedback') where.push('player_feedback_count > 0');
  if (filter === 'review') where.push('player_feedback_count > 0 AND player_feedback_stddev > 20');
  if (filter === 'locked') where.push('difficulty_locked = 1');
  if (filter === 'unlocked') where.push('difficulty_locked = 0');
  if (filter === 'edited') where.push('difficulty_manual_score IS NOT NULL');
  if (filter === 'excluded') where.push("pool_status = 'excluded'");
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderBy = {
    effective: 'difficulty_score',
    manual: 'difficulty_manual_score',
    feedback: 'player_feedback_mean',
    difference: 'ABS(COALESCE(difficulty_manual_score, difficulty_score) - COALESCE(player_feedback_mean, difficulty_score))',
    name: 'COALESCE(name_zh, name_en)',
  }[sort];
  const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM games ${whereSql}`).get(...parameters).count);
  const rows = db.prepare(`${ROW_SELECT} ${whereSql} ORDER BY ${orderBy} ${direction}, appid ASC LIMIT ? OFFSET ?`)
    .all(...parameters, pageSize, (page - 1) * pageSize)
    .map(rowPayload);
  return { rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

export function getEffectiveDifficultyMap(db) {
  const rows = db.prepare(`
    SELECT appid, difficulty_score, difficulty_source
    FROM games
    WHERE pool_status <> 'excluded' AND difficulty_score IS NOT NULL
  `).all();
  return new Map(rows.map(row => [Number(row.appid), {
    score: Number(row.difficulty_score),
    level: levelForScore(Number(row.difficulty_score)),
    source: row.difficulty_source || 'manual',
  }]));
}

export function getHiddenCatalogAppIds(db) {
  return new Set(db.prepare("SELECT appid FROM games WHERE pool_status = 'excluded'").all().map(row => Number(row.appid)));
}

export function upsertDifficultyOverride(db, appId, { manualScore, locked }, now = new Date().toISOString()) {
  const app = db.prepare('SELECT * FROM games WHERE appid = ?').get(appId);
  if (!app) return null;
  let nextScore = manualScore === undefined ? app.difficulty_manual_score : manualScore;
  const nextLocked = locked === undefined ? Boolean(app.difficulty_locked) : Boolean(locked);
  if (nextLocked && nextScore == null) nextScore = app.difficulty_score;
  const score = nextScore == null ? app.difficulty_score : Number(nextScore);
  db.prepare(`
    UPDATE games
    SET difficulty_manual_score = ?, difficulty_locked = ?,
        difficulty_score = ?, difficulty_tier = ?,
        difficulty_source = ?, updated_at = ?
    WHERE appid = ?
  `).run(
    nextScore == null ? null : Number(nextScore),
    nextLocked ? 1 : 0,
    score == null ? null : score,
    score == null ? null : levelForScore(score),
    score == null ? null : (nextLocked ? 'manual_locked' : 'manual'),
    now,
    appId,
  );
  return getDifficultyRow(db, appId);
}

export function setCatalogExclusion(db, appId, { excluded, reason }, now = new Date().toISOString()) {
  const app = db.prepare('SELECT appid FROM games WHERE appid = ?').get(appId);
  if (!app) return null;
  if (excluded) {
    const normalizedReason = [...EXCLUDED_REASONS, ...SEARCH_ONLY_REASONS].includes(reason)
      ? reason
      : 'manual_exclusion';
    const nextStatus = SEARCH_ONLY_REASONS.includes(normalizedReason) ? 'search_only' : 'excluded';
    db.prepare(`
      UPDATE games
      SET pool_status = ?, status_reason = ?,
          difficulty_score = CASE WHEN ? = 'excluded' THEN NULL ELSE difficulty_score END,
          difficulty_tier = CASE WHEN ? = 'excluded' THEN NULL ELSE difficulty_tier END,
          updated_at = ?
      WHERE appid = ?
    `).run(nextStatus, normalizedReason, nextStatus, nextStatus, now, appId);
  } else {
    db.prepare("UPDATE games SET pool_status = 'eligible', status_reason = NULL, updated_at = ? WHERE appid = ?").run(now, appId);
  }
  return getDifficultyRow(db, appId);
}
