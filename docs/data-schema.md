# SteamGuess catalog schema

## Storage boundary

The catalog database is `data/catalog/catalog.sqlite`. The application catalog
has one business table:

```text
games              one row per Steam AppID
catalog_meta       release-level key/value metadata
schema_migrations  schema version history
```

Player/session data is intentionally separate:

```text
data/runtime/steamguess.sqlite
```

It stores players, sessions and raw difficulty feedback. A feedback aggregation
job writes the current aggregate back to the corresponding `games` row.

## `games`

`appid` is the primary key. Columns are grouped by purpose:

### Identity and display

`name_en`, `name_zh`, `app_type`, `release_date`, `cover_url`,
`developers_json`, `publishers_json`, `tags_json`, `screenshot_urls_json`.

### Prices and Steam metrics

The database stores regular US/CN prices, never the current discount price:

`price_us_*`, `price_cn_*`, `steam_*`, `heat_score`, `heat_rank`.

`heat_rank` is display information only and is not a pool-membership rule.

### Pool and editorial difficulty

`pool_status` is the single availability flag:

```text
eligible     searchable and valid as an answer
search_only  searchable but never an answer
excluded     not searchable and not an answer
```

`status_reason` records why an editorial status was chosen. Difficulty is
stored directly on the row:

`difficulty_score`, `difficulty_tier`, `difficulty_manual_score`,
`difficulty_locked`, `difficulty_source`, and the player feedback aggregate
columns.

Valid tiers are `beginner`, `easy`, `normal`, `hard`, `hell`, with ranges
`0–14`, `15–24`, `25–49`, `50–74`, and `75–100`.

### Source preservation

The following JSON columns preserve the latest source payloads and provenance:

`raw_steamspy_json`, `raw_pics_json`, `raw_storefront_json`,
`raw_reviews_json`, `raw_sources_json`, `source_meta_json`,
`enrichment_status_json`, `field_provenance_json`.

Array fields and raw payloads stay on the same game row. Weekly imports merge
new non-empty source values and do not erase existing expensive metadata when a
partial response is received.

## Published snapshot

`public/games_demo.json` is generated from `games` and is a deployment artifact,
not a second source of truth. It contains the current search catalog; only rows
with `pool_status = eligible` and a valid difficulty are answer candidates.

The old normalized tables and old difficulty tables are not created by the new
schema. `scripts/catalog/migrate_catalog.py` can read them once during offline
migration, but they are not part of the resulting database.
