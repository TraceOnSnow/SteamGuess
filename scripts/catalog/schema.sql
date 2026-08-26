PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS catalog_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS apps (
    appid INTEGER PRIMARY KEY CHECK (appid > 0),
    canonical_name TEXT NOT NULL,
    app_type TEXT,
    release_date TEXT,
    pics_change_number INTEGER,
    search_eligible INTEGER NOT NULL DEFAULT 0 CHECK (search_eligible IN (0, 1)),
    playable_eligible INTEGER NOT NULL DEFAULT 0 CHECK (playable_eligible IN (0, 1)),
    excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_names (
    appid INTEGER NOT NULL REFERENCES apps(appid) ON DELETE CASCADE,
    locale TEXT NOT NULL,
    country TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    retrieved_at TEXT,
    PRIMARY KEY (appid, locale, country, source)
);

CREATE TABLE IF NOT EXISTS app_companies (
    appid INTEGER NOT NULL REFERENCES apps(appid) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('developer', 'publisher')),
    position INTEGER NOT NULL CHECK (position >= 0),
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    retrieved_at TEXT,
    PRIMARY KEY (appid, role, position)
);
CREATE INDEX IF NOT EXISTS idx_app_companies_name ON app_companies(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS app_tags (
    appid INTEGER NOT NULL REFERENCES apps(appid) ON DELETE CASCADE,
    source TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    tag_id INTEGER,
    name TEXT NOT NULL,
    retrieved_at TEXT,
    PRIMARY KEY (appid, source, position)
);
CREATE INDEX IF NOT EXISTS idx_app_tags_name ON app_tags(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS app_prices (
    appid INTEGER NOT NULL REFERENCES apps(appid) ON DELETE CASCADE,
    country TEXT NOT NULL,
    currency TEXT,
    status TEXT NOT NULL CHECK (status IN ('available', 'free', 'unavailable', 'unknown')),
    regular_cents INTEGER CHECK (regular_cents IS NULL OR regular_cents >= 0),
    current_cents INTEGER CHECK (current_cents IS NULL OR current_cents >= 0),
    discount_percent INTEGER CHECK (discount_percent IS NULL OR discount_percent BETWEEN 0 AND 100),
    source TEXT NOT NULL,
    retrieved_at TEXT NOT NULL,
    PRIMARY KEY (appid, country, source, retrieved_at)
);
CREATE INDEX IF NOT EXISTS idx_app_prices_latest ON app_prices(appid, country, retrieved_at DESC);

CREATE TABLE IF NOT EXISTS app_media (
    appid INTEGER NOT NULL REFERENCES apps(appid) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('header', 'screenshot', 'background', 'capsule', 'other')),
    position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
    url TEXT NOT NULL,
    source TEXT NOT NULL,
    retrieved_at TEXT,
    PRIMARY KEY (appid, kind, position)
);

CREATE TABLE IF NOT EXISTS app_metrics (
    appid INTEGER NOT NULL REFERENCES apps(appid) ON DELETE CASCADE,
    source TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    ccu INTEGER,
    peak_yesterday INTEGER,
    peak_7d INTEGER,
    peak_7d_samples INTEGER,
    owners_min INTEGER,
    owners_max INTEGER,
    positive INTEGER,
    negative INTEGER,
    reviews_total INTEGER,
    average_forever_minutes INTEGER,
    average_two_weeks_minutes INTEGER,
    median_forever_minutes INTEGER,
    median_two_weeks_minutes INTEGER,
    raw_json TEXT,
    PRIMARY KEY (appid, source, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_app_metrics_latest ON app_metrics(appid, observed_at DESC);

-- Editorial difficulty values are independent from weekly catalog imports.
-- Only locked values override player feedback and the AI candidate baseline.
CREATE TABLE IF NOT EXISTS difficulty_overrides (
    appid INTEGER PRIMARY KEY REFERENCES apps(appid) ON DELETE CASCADE,
    manual_score REAL CHECK (manual_score IS NULL OR manual_score BETWEEN 0 AND 100),
    locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_difficulty_overrides_locked
    ON difficulty_overrides(locked, updated_at);

-- Accepted player-feedback adjustments start from the AI candidate baseline.
-- Editorial locks still win. The full audit trail remains append-only.
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
CREATE INDEX IF NOT EXISTS idx_difficulty_feedback_history_app
    ON difficulty_feedback_history(appid, created_at DESC);

-- Editorial catalog exclusions survive weekly rank refreshes. This is separate
-- from apps.excluded, which describes eligibility derived from imported source
-- data and may legitimately change on the next import.
CREATE TABLE IF NOT EXISTS catalog_exclusions (
    appid INTEGER PRIMARY KEY REFERENCES apps(appid) ON DELETE CASCADE,
    reason TEXT NOT NULL CHECK (reason IN ('unsuitable', 'too_obscure')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_catalog_exclusions_reason
    ON catalog_exclusions(reason, updated_at);

CREATE TABLE IF NOT EXISTS source_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    retrieved_at TEXT NOT NULL,
    raw_path TEXT,
    payload_sha256 TEXT,
    item_count INTEGER,
    status TEXT NOT NULL DEFAULT 'success',
    metadata_json TEXT,
    UNIQUE (service, endpoint, retrieved_at, payload_sha256)
);

CREATE TABLE IF NOT EXISTS source_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    appid INTEGER REFERENCES apps(appid) ON DELETE CASCADE,
    batch_id INTEGER REFERENCES source_batches(id) ON DELETE SET NULL,
    service TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    locale TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    retrieved_at TEXT NOT NULL,
    change_number INTEGER,
    raw_path TEXT,
    payload_sha256 TEXT,
    payload_json TEXT,
    UNIQUE (appid, service, endpoint, locale, country, retrieved_at)
);
CREATE INDEX IF NOT EXISTS idx_source_observations_app ON source_observations(appid, service, retrieved_at DESC);

CREATE TABLE IF NOT EXISTS field_provenance (
    appid INTEGER NOT NULL REFERENCES apps(appid) ON DELETE CASCADE,
    field_name TEXT NOT NULL,
    source TEXT NOT NULL,
    retrieved_at TEXT,
    PRIMARY KEY (appid, field_name)
);

CREATE TABLE IF NOT EXISTS catalog_memberships (
    catalog TEXT NOT NULL,
    appid INTEGER NOT NULL REFERENCES apps(appid) ON DELETE CASCADE,
    included_at TEXT NOT NULL,
    reason TEXT,
    PRIMARY KEY (catalog, appid)
);
CREATE INDEX IF NOT EXISTS idx_catalog_memberships_app ON catalog_memberships(appid, catalog);

CREATE TABLE IF NOT EXISTS enrichment_jobs (
    appid INTEGER NOT NULL REFERENCES apps(appid) ON DELETE CASCADE,
    service TEXT NOT NULL,
    locale TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'unavailable', 'failed', 'skipped')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT,
    next_attempt_at TEXT,
    source_change_number INTEGER,
    last_error TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (appid, service, locale, country)
);
CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_queue ON enrichment_jobs(status, service, next_attempt_at);

CREATE VIEW IF NOT EXISTS latest_app_metrics AS
SELECT metric.*
FROM app_metrics AS metric
WHERE metric.observed_at = (
    SELECT MAX(candidate.observed_at)
    FROM app_metrics AS candidate
    WHERE candidate.appid = metric.appid AND candidate.source = metric.source
);

CREATE VIEW IF NOT EXISTS latest_app_prices AS
SELECT price.*
FROM app_prices AS price
WHERE price.retrieved_at = (
    SELECT MAX(candidate.retrieved_at)
    FROM app_prices AS candidate
    WHERE candidate.appid = price.appid
      AND candidate.country = price.country
      AND candidate.source = price.source
);

CREATE TABLE IF NOT EXISTS app_reviews (
    appid INTEGER NOT NULL REFERENCES apps(appid) ON DELETE CASCADE,
    language TEXT NOT NULL CHECK (language IN ('english', 'schinese')),
    position INTEGER NOT NULL CHECK (position >= 1 AND position <= 100),
    review_id TEXT NOT NULL,
    review_text TEXT NOT NULL,
    voted_up INTEGER,
    votes_up INTEGER,
    votes_funny INTEGER,
    weighted_vote_score REAL,
    timestamp_created INTEGER,
    timestamp_updated INTEGER,
    source TEXT NOT NULL,
    retrieved_at TEXT NOT NULL,
    review_hash TEXT NOT NULL,
    PRIMARY KEY (appid, language, position),
    UNIQUE (appid, language, review_hash)
);
CREATE INDEX IF NOT EXISTS idx_app_reviews_app ON app_reviews(appid, language, position);

-- AI redactions are a derived sidecar keyed by the exact source review hash.
-- Raw review text remains authoritative in app_reviews.
CREATE TABLE IF NOT EXISTS review_redactions (
    task_id TEXT PRIMARY KEY,
    appid INTEGER NOT NULL,
    language TEXT NOT NULL CHECK (language IN ('english', 'schinese')),
    review_id TEXT NOT NULL,
    review_hash TEXT NOT NULL,
    redacted_text TEXT NOT NULL,
    entities_json TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    processed_at TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    source_path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_redactions_review
    ON review_redactions(appid, language, review_id);

-- Independent AI difficulty candidates. These are review inputs, never the
-- effective published score until explicitly copied/locked by an editor.
CREATE TABLE IF NOT EXISTS difficulty_ai_candidates (
    appid INTEGER PRIMARY KEY REFERENCES apps(appid) ON DELETE CASCADE,
    score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
    level TEXT NOT NULL CHECK (level IN ('beginner', 'easy', 'normal', 'hard', 'hell')),
    confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    reason TEXT NOT NULL,
    eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
    exclusion_reason TEXT,
    review_priority TEXT NOT NULL CHECK (review_priority IN ('high', 'normal', 'low')),
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    evaluated_at TEXT NOT NULL,
    source_path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_difficulty_ai_candidates_priority
    ON difficulty_ai_candidates(review_priority, eligible, score);
