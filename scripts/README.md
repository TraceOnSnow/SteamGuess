# SteamGuess scripts

Production catalog work starts from one command:

```bash
./scripts/ops/run_weekly_catalog.sh
```

The runner is resumable and publishes only after validation. Its staged files are
kept under `data/catalog/.weekly-work/current/`; rerunning the same command
continues from the last checkpoint.

## Data scripts

| Script | Responsibility | Network |
|---|---|---:|
| `discover_steamspy.py` | Fetch SteamSpy `request=all`, save page raw checkpoints, normalize candidates | Yes |
| `enrich_pics.py` | Merge a PICS snapshot into the staged catalog | No |
| `enrich_storefront.py` | Fetch localized names, regular prices, companies, dates and screenshots | Yes |
| `enrich_reviews.py` | Fetch English and Simplified Chinese review snapshots | Yes |
| `import_current.py` | Idempotently upsert the catalog into SQLite | No |
| `publish_playable.py` | Generate `public/games_demo.json` from SQLite | No |
| `update_weekly.py` | Orchestrate discovery, checkpointed enrichment, import and publish | Depends |
| `migrate_catalog.py` | One-time migration from the old normalized database | No |
| `status.py` | Report catalog completeness | No |
| `update_difficulty_from_feedback.py` | Apply validated player feedback to the catalog | No |
| `redact_reviews_ai.py` | Optional review-cleaning checkpoint producer | Provider-dependent |
| `import_review_redactions.py` | Write validated cleaned review text into game JSON | No |

## Canonical storage

`data/catalog/catalog.sqlite` is the catalog authority. It has one business row
per Steam AppID in `games`; source payloads and array fields are JSON columns on
the same row. `catalog_meta` stores release metadata and `schema_migrations`
stores schema versioning.

The catalog row contains:

- canonical English/Chinese names, date, companies, tags and screenshots;
- regular US/CN prices only;
- SteamSpy metrics and heat rank;
- original source payloads and field provenance;
- `pool_status`: `eligible`, `search_only` or `excluded`;
- current editorial difficulty, lock state and aggregate player feedback.

`data/runtime/steamguess.sqlite` remains separate for players, sessions and raw
feedback. It is not merged into the catalog database.

## Pool and difficulty rules

`heat_rank` is display data only. It does not decide whether a game can be used.

- `eligible`: searchable and may be selected as an answer;
- `search_only`: searchable but never selected as an answer;
- `excluded`: hidden from search and answers.

Difficulty is editorial/player data. The only effective sources are manual scores
and validated player feedback. The score range is integer `0..100`:

```text
0–14 beginner    15–24 easy    25–49 normal
50–74 hard       75–100 hell
```

A locked manual score is authoritative. An unlocked manual score is an editor
draft; player feedback can update an unlocked row.

## Useful commands

```bash
# inspect without network work
STEAMGUESS_WEEKLY_FROM_EXISTING=1 \
STEAMGUESS_WEEKLY_SKIP_ENRICHMENT=1 \
./scripts/ops/run_weekly_catalog.sh

# normal weekly run, with a 1000-game answer/search window and 4000-game detail window
STEAMGUESS_ACTIVE_LIMIT=1000 \
STEAMGUESS_DETAIL_LIMIT=4000 \
./scripts/ops/run_weekly_catalog.sh

python3 -m scripts.catalog.status --db data/catalog/catalog.sqlite
./scripts/ops/update_difficulty_from_feedback.sh
python3 -m unittest discover -s scripts/tests -p 'test_*.py'
```

The detailed Chinese operator guide is
[`CATALOG_PIPELINE.zh-CN.md`](./CATALOG_PIPELINE.zh-CN.md).
