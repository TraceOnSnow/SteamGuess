# SteamGuess catalog pipeline

## One weekly entry point

```bash
./scripts/ops/run_weekly_catalog.sh
```

The wrapper owns the lock, persistent staging directory, checkpoints, release
validation, backup and atomic replacement. A failed run leaves its staging
workspace intact; rerunning resumes it.

```text
SteamSpy request=all pages
  → staged candidate JSON + raw page checkpoints
  → restore metadata already present in catalog.sqlite
  → enrich missing PICS / Storefront / Reviews fields
  → import/upsert one-row-per-game SQLite catalog
  → publish public/games_demo.json
  → validate catalog, search window and answer subset
  → backup and atomically replace production files
```

## Windows

- **Candidate catalog**: all discovered AppIDs retained in SQLite.
- **Active/search window**: the first `STEAMGUESS_ACTIVE_LIMIT` non-excluded
  candidates in SteamSpy order.
- **Detail window**: the first `STEAMGUESS_DETAIL_LIMIT` non-excluded candidates
  receive expensive metadata enrichment.
- **Reserve**: the rest remain stored for later use.

The relationship is:

```text
answers ⊆ search ⊆ candidate catalog
```

`heat_rank` may be shown in the UI, but it does not determine eligibility.

## Sources

- **SteamSpy**: candidate discovery, review counts, CCU, owners and other
  aggregate metrics. Each successful page is saved as a raw checkpoint.
- **PICS**: Steam app type, change number and user tags. Automatic runs use
  durable 500-AppID chunks.
- **Storefront**: localized names, regular regional prices, developers,
  publishers, release date and all available screenshots. Current discount
  prices are not canonical data.
- **Reviews endpoint**: up to the configured English and Simplified Chinese
  review snapshots, stored as JSON on the game row.

## Resume and missing-field behavior

The runner restores known fields from the canonical SQLite row before planning.
It then requests only missing data for the configured detail window. New empty
values do not replace known values, and raw source objects are merged rather
than discarded.

Checkpoints are kept for:

- SteamSpy pages;
- PICS chunks;
- Storefront state;
- review results;
- the complete staged catalog and database.

Do not delete `data/catalog/.weekly-work/current/` while a run is being resumed.

## Difficulty and player feedback

Difficulty is not computed by a weekly ranking or regression process. It is
maintained in `games` by the internal labeler and later adjusted by validated
player feedback.

```text
manual score + lock       → editorial authority
player feedback           → aggregate update for unlocked rows
pool_status = excluded    → never searchable
pool_status = search_only → searchable, never an answer
```

The feedback synchronizer is:

```bash
./scripts/ops/update_difficulty_from_feedback.sh
```

## One-time migration

To migrate the existing normalized database without losing source metadata:

```bash
python3 -m scripts.catalog.migrate_catalog \
  --source data/catalog/catalog.sqlite \
  --catalog data/catalog/steamspy_candidates.json \
  --raw-steamspy-dir data/raw/steamspy \
  --output /tmp/steamguess-converged.sqlite
```

Validate the output before replacing the production database. The migration
keeps AppIDs, source payloads and current metadata, while intentionally dropping
legacy difficulty tables and their historical values.
