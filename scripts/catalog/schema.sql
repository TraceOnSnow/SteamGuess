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

CREATE TABLE IF NOT EXISTS app_scores (
    appid INTEGER PRIMARY KEY REFERENCES apps(appid) ON DELETE CASCADE,
    recognition_score REAL,
    recognition_features_json TEXT,
    difficulty_score REAL,
    difficulty_level TEXT CHECK (difficulty_level IN ('easy', 'normal', 'hard', 'hell') OR difficulty_level IS NULL),
    difficulty_source TEXT,
    manual_level TEXT CHECK (manual_level IN ('easy', 'normal', 'hard', 'hell') OR manual_level IS NULL),
    updated_at TEXT NOT NULL
);

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

-- Human-curated preset pool. This is intentionally separate from the
-- regression score so weekly catalog refreshes cannot erase editorial choices.
CREATE TABLE IF NOT EXISTS curated_pool_entries (
    pool_version TEXT NOT NULL,
    appid INTEGER NOT NULL REFERENCES apps(appid) ON DELETE CASCADE,
    source_name TEXT NOT NULL,
    difficulty_rank INTEGER NOT NULL CHECK (difficulty_rank BETWEEN 1 AND 4),
    tier TEXT NOT NULL CHECK (tier IN ('easy', 'normal', 'hard', 'hell')),
    basis TEXT,
    user_rating REAL,
    match_method TEXT NOT NULL,
    included_at TEXT NOT NULL,
    PRIMARY KEY (pool_version, appid)
);
CREATE INDEX IF NOT EXISTS idx_curated_pool_entries_difficulty
    ON curated_pool_entries(pool_version, difficulty_rank);

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
    position INTEGER NOT NULL CHECK (position >= 1 AND position <= 10),
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
