import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const LEVELS = ['beginner', 'easy', 'normal', 'hard', 'hell'];
const EXCLUSION_REASONS = ['unsuitable', 'too_obscure'];

function levelForScore(score) {
  if (score < 15) return 'beginner';
  if (score < 25) return 'easy';
  if (score < 50) return 'normal';
  if (score < 75) return 'hard';
  return 'hell';
}

export function openCatalogDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS difficulty_overrides (
      appid INTEGER PRIMARY KEY REFERENCES apps(appid) ON DELETE CASCADE,
      manual_score REAL CHECK (manual_score IS NULL OR manual_score BETWEEN 0 AND 100),
      locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_difficulty_overrides_locked
      ON difficulty_overrides(locked, updated_at);
    CREATE TABLE IF NOT EXISTS difficulty_feedback_scores (
      appid INTEGER PRIMARY KEY REFERENCES apps(appid) ON DELETE CASCADE,
      base_score REAL NOT NULL CHECK (base_score BETWEEN 0 AND 100),
      candidate_score REAL NOT NULL CHECK (candidate_score BETWEEN 0 AND 100),
      current_score REAL CHECK (current_score IS NULL OR current_score BETWEEN 0 AND 100),
      sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
      mean_score REAL NOT NULL CHECK (mean_score BETWEEN 0 AND 100),
      stddev REAL NOT NULL CHECK (stddev >= 0),
      prior_weight REAL NOT NULL CHECK (prior_weight >= 0),
      max_delta REAL NOT NULL CHECK (max_delta >= 0),
      status TEXT NOT NULL CHECK (status IN ('applied', 'review', 'insufficient', 'locked')),
      source_digest TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_difficulty_feedback_scores_status
      ON difficulty_feedback_scores(status, sample_count, updated_at);
    CREATE TABLE IF NOT EXISTS difficulty_feedback_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      appid INTEGER NOT NULL REFERENCES apps(appid) ON DELETE CASCADE,
      base_score REAL NOT NULL CHECK (base_score BETWEEN 0 AND 100),
      candidate_score REAL NOT NULL CHECK (candidate_score BETWEEN 0 AND 100),
      result_score REAL CHECK (result_score IS NULL OR result_score BETWEEN 0 AND 100),
      sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
      mean_score REAL NOT NULL CHECK (mean_score BETWEEN 0 AND 100),
      stddev REAL NOT NULL CHECK (stddev >= 0),
      prior_weight REAL NOT NULL CHECK (prior_weight >= 0),
      max_delta REAL NOT NULL CHECK (max_delta >= 0),
      status TEXT NOT NULL CHECK (status IN ('applied', 'review', 'insufficient', 'locked')),
      source_digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(appid, source_digest)
    );
    CREATE TABLE IF NOT EXISTS catalog_exclusions (
      appid INTEGER PRIMARY KEY REFERENCES apps(appid) ON DELETE CASCADE,
      reason TEXT NOT NULL CHECK (reason IN ('unsuitable', 'too_obscure')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_catalog_exclusions_reason
      ON catalog_exclusions(reason, updated_at);
    CREATE TABLE IF NOT EXISTS difficulty_ai_candidates (
      appid INTEGER PRIMARY KEY REFERENCES apps(appid) ON DELETE CASCADE,
      score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
      level TEXT NOT NULL CHECK (level IN ('beginner', 'easy', 'normal', 'hard', 'hell')),
      confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
      reason TEXT NOT NULL,
      eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
      exclusion_reason TEXT,
      review_priority TEXT NOT NULL CHECK (review_priority IN ('high', 'normal', 'low')),
      model TEXT NOT NULL, prompt_version TEXT NOT NULL, evaluated_at TEXT NOT NULL, source_path TEXT NOT NULL
    );
  `);
  return db;
}

function rowPayload(row) {
  if (!row) return null;
  const manualScore = row.manual_score == null ? null : Number(row.manual_score);
  const feedbackScore = row.feedback_score == null ? null : Number(row.feedback_score);
  const aiCandidateScore = row.ai_candidate_score == null ? null : Number(row.ai_candidate_score);
  const locked = Boolean(row.locked);
  const effectiveScore = locked && manualScore != null ? manualScore : (feedbackScore ?? aiCandidateScore);
  return {
    appId: Number(row.appid),
    name: row.canonical_name,
    localizedName: row.localized_name || null,
    manualScore,
    locked,
    feedbackScore,
    feedbackCandidateScore: row.feedback_candidate_score == null ? null : Number(row.feedback_candidate_score),
    feedbackCount: row.feedback_count == null ? 0 : Number(row.feedback_count),
    feedbackMean: row.feedback_mean == null ? null : Number(row.feedback_mean),
    feedbackStddev: row.feedback_stddev == null ? null : Number(row.feedback_stddev),
    feedbackStatus: row.feedback_status || null,
    feedbackUpdatedAt: row.feedback_updated_at || null,
    effectiveScore,
    effectiveLevel: effectiveScore == null ? null : levelForScore(effectiveScore),
    effectiveSource: locked && manualScore != null ? 'editorial-lock' : feedbackScore != null ? 'player-feedback' : aiCandidateScore != null ? 'ai-candidate' : null,
    aiCandidateScore,
    aiCandidateLevel: LEVELS.includes(row.ai_candidate_level) ? row.ai_candidate_level : null,
    aiCandidateConfidence: row.ai_candidate_confidence == null ? null : Number(row.ai_candidate_confidence),
    aiCandidateReason: row.ai_candidate_reason || null,
    aiCandidateEligible: row.ai_candidate_eligible == null ? null : Boolean(row.ai_candidate_eligible),
    aiCandidatePriority: row.ai_candidate_priority || null,
    updatedAt: row.override_updated_at || null,
    active: Boolean(row.active),
    excluded: Boolean(row.editorially_excluded),
    exclusionReason: EXCLUSION_REASONS.includes(row.exclusion_reason) ? row.exclusion_reason : null,
    exclusionUpdatedAt: row.exclusion_updated_at || null,
  };
}

const ROW_SELECT = `
  SELECT
    a.appid,
    a.canonical_name,
    (SELECT n.name FROM app_names n
      WHERE n.appid = a.appid AND n.locale = 'schinese'
      ORDER BY CASE WHEN n.country = 'CN' THEN 0 ELSE 1 END, n.retrieved_at DESC
      LIMIT 1) AS localized_name,
    o.manual_score,
    COALESCE(o.locked, 0) AS locked,
    o.updated_at AS override_updated_at,
    feedback.current_score AS feedback_score,
    feedback.candidate_score AS feedback_candidate_score,
    feedback.sample_count AS feedback_count,
    feedback.mean_score AS feedback_mean,
    feedback.stddev AS feedback_stddev,
    feedback.status AS feedback_status,
    feedback.updated_at AS feedback_updated_at,
    ai.score AS ai_candidate_score,
    ai.level AS ai_candidate_level,
    ai.confidence AS ai_candidate_confidence,
    ai.reason AS ai_candidate_reason,
    ai.eligible AS ai_candidate_eligible,
    ai.review_priority AS ai_candidate_priority,
    x.reason AS exclusion_reason,
    x.updated_at AS exclusion_updated_at,
    x.appid IS NOT NULL AS editorially_excluded,
    EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.appid = a.appid AND m.catalog = 'active') AS active
  FROM apps a
  LEFT JOIN difficulty_overrides o ON o.appid = a.appid
  LEFT JOIN difficulty_feedback_scores feedback ON feedback.appid = a.appid
  LEFT JOIN difficulty_ai_candidates ai ON ai.appid = a.appid
  LEFT JOIN catalog_exclusions x ON x.appid = a.appid
`;

export function getDifficultyRow(db, appId) {
  return rowPayload(db.prepare(`${ROW_SELECT} WHERE a.appid = ?`).get(appId));
}

export function listDifficulties(db, options = {}) {
  const query = String(options.query || '').trim();
  const filter = ['all', 'candidate', 'feedback', 'review', 'locked', 'unlocked', 'edited', 'excluded'].includes(options.filter) ? options.filter : 'all';
  const scope = options.scope === 'all' ? 'all' : 'active';
  const sort = ['effective', 'manual', 'feedback', 'ai', 'difference', 'name'].includes(options.sort) ? options.sort : 'effective';
  const direction = options.direction === 'desc' ? 'DESC' : 'ASC';
  const page = Math.max(1, Number.parseInt(options.page, 10) || 1);
  const pageSize = Math.max(20, Math.min(500, Number.parseInt(options.pageSize, 10) || 100));
  const where = ['ai.eligible = 1'];
  const parameters = [];
  if (scope === 'active') where.push("EXISTS(SELECT 1 FROM catalog_memberships am WHERE am.appid = a.appid AND am.catalog = 'active')");
  if (query) {
    where.push(`(a.canonical_name LIKE ? COLLATE NOCASE OR CAST(a.appid AS TEXT) = ? OR EXISTS(
      SELECT 1 FROM app_names qn WHERE qn.appid = a.appid AND qn.name LIKE ? COLLATE NOCASE
    ))`);
    parameters.push(`%${query}%`, query, `%${query}%`);
  }
  if (filter === 'candidate') where.push('ai.appid IS NOT NULL');
  if (filter === 'feedback') where.push('feedback.appid IS NOT NULL');
  if (filter === 'review') where.push("feedback.status = 'review'");
  if (filter === 'locked') where.push('COALESCE(o.locked, 0) = 1');
  if (filter === 'unlocked') where.push('COALESCE(o.locked, 0) = 0');
  if (filter === 'edited') where.push('o.manual_score IS NOT NULL');
  if (filter === 'excluded') where.push('x.appid IS NOT NULL');
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const effective = 'CASE WHEN COALESCE(o.locked, 0) = 1 AND o.manual_score IS NOT NULL THEN o.manual_score ELSE COALESCE(feedback.current_score, ai.score) END';
  const orderBy = {
    effective: effective,
    manual: 'o.manual_score',
    feedback: 'feedback.current_score',
    ai: 'ai.score',
    difference: 'ABS(COALESCE(o.manual_score, feedback.current_score, ai.score) - ai.score)',
    name: 'COALESCE(localized_name, a.canonical_name)',
  }[sort];
  const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM apps a LEFT JOIN difficulty_overrides o ON o.appid = a.appid LEFT JOIN difficulty_feedback_scores feedback ON feedback.appid = a.appid LEFT JOIN difficulty_ai_candidates ai ON ai.appid = a.appid LEFT JOIN catalog_exclusions x ON x.appid = a.appid ${whereSql}`).get(...parameters).count);
  const rows = db.prepare(`${ROW_SELECT} ${whereSql} ORDER BY ${orderBy} ${direction}, a.appid ASC LIMIT ? OFFSET ?`)
    .all(...parameters, pageSize, (page - 1) * pageSize)
    .map(rowPayload);
  return { rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

export function getEffectiveDifficultyMap(db) {
  const rows = db.prepare(`
    SELECT
      a.appid,
      CASE
        WHEN COALESCE(o.locked, 0) = 1 AND o.manual_score IS NOT NULL THEN o.manual_score
        ELSE COALESCE(feedback.current_score, ai.score)
      END AS score,
      CASE
        WHEN COALESCE(o.locked, 0) = 1 AND o.manual_score IS NOT NULL THEN 'editorial-lock'
        WHEN feedback.current_score IS NOT NULL THEN 'player-feedback'
        ELSE 'ai-candidate'
      END AS source
    FROM apps AS a
    JOIN difficulty_ai_candidates AS ai ON ai.appid = a.appid
    LEFT JOIN difficulty_overrides AS o ON o.appid = a.appid
    LEFT JOIN difficulty_feedback_scores AS feedback ON feedback.appid = a.appid
    LEFT JOIN catalog_exclusions AS exclusion ON exclusion.appid = a.appid
    WHERE exclusion.appid IS NULL
      AND ai.eligible = 1
  `).all();
  return new Map(rows
    .filter(row => Number.isFinite(row.score))
    .map(row => [Number(row.appid), {
      score: Number(row.score),
      level: levelForScore(Number(row.score)),
      source: row.source || 'unknown',
    }]));
}

export function getHiddenCatalogAppIds(db) {
  const rows = db.prepare(`
    SELECT appid FROM catalog_exclusions
    UNION
    SELECT appid FROM difficulty_ai_candidates WHERE eligible = 0
  `).all();
  return new Set(rows.map(row => Number(row.appid)));
}

export function upsertDifficultyOverride(db, appId, { manualScore, locked }, now = new Date().toISOString()) {
  const app = db.prepare('SELECT appid FROM apps WHERE appid = ?').get(appId);
  if (!app) return null;
  const existing = db.prepare('SELECT manual_score, locked FROM difficulty_overrides WHERE appid = ?').get(appId);
  let nextScore = manualScore === undefined ? existing?.manual_score ?? null : manualScore;
  const nextLocked = locked === undefined ? Boolean(existing?.locked) : Boolean(locked);
  if (nextLocked && nextScore == null) {
    nextScore = db.prepare(`
      SELECT COALESCE(feedback.current_score, ai.score) AS score
      FROM apps
      LEFT JOIN difficulty_ai_candidates AS ai ON ai.appid = apps.appid AND ai.eligible = 1
      LEFT JOIN difficulty_feedback_scores AS feedback ON feedback.appid = apps.appid
      WHERE apps.appid = ?
    `).get(appId)?.score ?? null;
  }
  db.prepare(`
    INSERT INTO difficulty_overrides(appid, manual_score, locked, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(appid) DO UPDATE SET
      manual_score = excluded.manual_score,
      locked = excluded.locked,
      updated_at = excluded.updated_at
  `).run(appId, nextScore, nextLocked ? 1 : 0, now);
  return getDifficultyRow(db, appId);
}

export function setCatalogExclusion(db, appId, { excluded, reason }, now = new Date().toISOString()) {
  const app = db.prepare('SELECT appid FROM apps WHERE appid = ?').get(appId);
  if (!app) return null;
  if (excluded) {
    const normalizedReason = EXCLUSION_REASONS.includes(reason) ? reason : 'unsuitable';
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        INSERT INTO catalog_exclusions(appid, reason, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(appid) DO UPDATE SET reason = excluded.reason, updated_at = excluded.updated_at
      `).run(appId, normalizedReason, now, now);
      db.prepare("DELETE FROM catalog_memberships WHERE appid = ? AND catalog IN ('active', 'search', 'playable')").run(appId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } else {
    db.prepare('DELETE FROM catalog_exclusions WHERE appid = ?').run(appId);
  }
  return getDifficultyRow(db, appId);
}
