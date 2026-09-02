PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- The catalog deliberately has one row per AppID.  Frequently queried values
-- are columns; arrays and complete source payloads stay on the same row as
-- JSON.  Player/session data lives in data/runtime/steamguess.sqlite.
CREATE TABLE IF NOT EXISTS games (
    appid INTEGER PRIMARY KEY CHECK (appid > 0),
    igdb_game_id INTEGER,
    name_en TEXT NOT NULL,
    name_zh TEXT,
    app_type TEXT,
    release_date TEXT,
    pics_change_number INTEGER,

    cover_url TEXT,
    developers_json TEXT NOT NULL DEFAULT '[]',
    publishers_json TEXT NOT NULL DEFAULT '[]',
    tags_json TEXT NOT NULL DEFAULT '[]',
    screenshot_urls_json TEXT NOT NULL DEFAULT '[]',
    reviews_en_json TEXT NOT NULL DEFAULT '[]',
    reviews_zh_json TEXT NOT NULL DEFAULT '[]',

    price_us_currency TEXT,
    price_us_status TEXT,
    price_us_regular_cents INTEGER,
    price_cn_currency TEXT,
    price_cn_status TEXT,
    price_cn_regular_cents INTEGER,

    steam_ccu INTEGER,
    steam_peak_yesterday INTEGER,
    steam_peak_7d INTEGER,
    steam_peak_7d_samples INTEGER,
    steam_owners_min INTEGER,
    steam_owners_max INTEGER,
    steam_positive INTEGER,
    steam_negative INTEGER,
    steam_reviews_total INTEGER,
    steam_average_forever_minutes INTEGER,
    steam_average_two_weeks_minutes INTEGER,
    steam_median_forever_minutes INTEGER,
    steam_median_two_weeks_minutes INTEGER,
    steam_metrics_json TEXT NOT NULL DEFAULT '{}',

    heat_score REAL,
    heat_rank INTEGER,

    -- pool_status is independent from heat_rank and difficulty:
    -- eligible = may be an answer and searchable;
    -- search_only = searchable but never an answer;
    -- excluded = neither searchable nor playable.
    pool_status TEXT NOT NULL DEFAULT 'eligible'
        CHECK (pool_status IN ('eligible', 'search_only', 'excluded')),
    status_reason TEXT,

    difficulty_score INTEGER CHECK (difficulty_score IS NULL OR difficulty_score BETWEEN 0 AND 100),
    difficulty_tier TEXT CHECK (
        difficulty_tier IS NULL OR
        difficulty_tier IN ('beginner', 'easy', 'normal', 'hard', 'hell')
    ),
    difficulty_manual_score INTEGER CHECK (
        difficulty_manual_score IS NULL OR difficulty_manual_score BETWEEN 0 AND 100
    ),
    difficulty_locked INTEGER NOT NULL DEFAULT 0 CHECK (difficulty_locked IN (0, 1)),
    difficulty_source TEXT,
    player_feedback_count INTEGER NOT NULL DEFAULT 0 CHECK (player_feedback_count >= 0),
    player_feedback_mean REAL,
    player_feedback_stddev REAL,
    player_feedback_updated_at TEXT,

    raw_steamspy_json TEXT,
    raw_pics_json TEXT,
    raw_storefront_json TEXT,
    raw_reviews_json TEXT,
    raw_sources_json TEXT NOT NULL DEFAULT '{}',
    source_meta_json TEXT NOT NULL DEFAULT '{}',
    enrichment_status_json TEXT NOT NULL DEFAULT '{}',
    field_provenance_json TEXT NOT NULL DEFAULT '{}',

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_games_name_en ON games(name_en COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_games_name_zh ON games(name_zh COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_games_pool_status ON games(pool_status);
CREATE INDEX IF NOT EXISTS idx_games_difficulty ON games(difficulty_tier, difficulty_score);
CREATE INDEX IF NOT EXISTS idx_games_heat_rank ON games(heat_rank);

CREATE TABLE IF NOT EXISTS catalog_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);
