# SteamGuess catalog schema

The canonical catalog is SQLite-backed. Its versioned schema is
`scripts/catalog/schema.sql`; the generated local database is
`data/catalog/catalog.sqlite`.

## Identity

`apps.appid` is the primary key. Canonical identity and eligibility live in
`apps`; active, search, and playable membership live in `catalog_memberships`.

Membership semantics are:

```text
active    SteamSpy rank window after durable editorial exclusions
search    Active rows exposed for search and guess submission
playable  Search rows with a valid effective difficulty, eligible as answers
```

The database must maintain `playable ⊆ search ⊆ active`.

## Metadata tables

- `app_names`: localized names by locale, country and source.
- `app_companies`: ordered developers and publishers.
- `app_tags`: ordered tags by source.
- `app_prices`: regional price history; regular and current price are separate.
- `app_media`: headers, screenshots and future media kinds.
- `app_metrics`: timestamped SteamSpy popularity and review observations.
- `app_reviews`: original English and Simplified Chinese review snapshots.
- `review_redactions`: AI-cleaned review text sidecar keyed by AppID, language,
  review identity and source hash. It does not overwrite `app_reviews`.
- `difficulty_overrides`: manual difficulty scores and editorial locks.
- `difficulty_feedback_scores`: validated aggregate player-feedback score and
  its sample/variance status.
- `difficulty_feedback_history`: append-only audit history of feedback
  synchronization results.
- `difficulty_ai_candidates`: baseline difficulty and game eligibility.
- `catalog_exclusions`: durable editorial removal from the active answer pool,
  with `unsuitable` or `too_obscure` as the reason.

The published effective difficulty follows:

```text
locked manual override > accepted player feedback > eligible AI candidate
```

`beginner` is the 0–14 score tier. The remaining tiers continue from 15
through 100.

An explicit AI decision with `eligible = false` removes a row from both Search
and Playable. A row without an AI candidate can remain in Search, but it has no
published difficulty and cannot become an answer.

## Provenance and refresh state

- `source_batches`: page/file-level fetch metadata, path and SHA-256.
- `source_observations`: per-App upstream source metadata and optional payload
  JSON. Normalized `catalog-import` rows retain only path/hash metadata because
  `source_batches` already hashes the complete catalog file; full per-App JSON
  is not duplicated on every import.
- `field_provenance`: source currently responsible for each canonical field.
- `enrichment_jobs`: resumable PICS, Storefront, and Reviews work queue.

Null or absent incoming values do not erase known enrichment. Metric and price
rows are historical rather than destructive replacements.

Discovery membership follows the original SteamSpy `request=all` order. The
catalog does not store or apply a derived popularity score.

## Runtime database separation

`data/runtime/steamguess.sqlite` stores players, sessions and feedback. It must
not be merged with the catalog database: they have different backup, deployment
and update lifecycles.

Feedback is copied into validated catalog-side aggregates by:

```bash
./scripts/ops/update_difficulty_from_feedback.sh
```

The raw submissions remain in the runtime database.

## Published hint schema

`public/games_demo.json` is the runtime Search snapshot. Every row can be used
as a guess; only rows with a valid `difficulty` object are in the answer pool.
It publishes hint material as arrays:

```text
hints.screenshotUrls[]   screenshot URLs
hints.reviewTexts[]      redacted reviews selected during publication
```

For `beginner` (0–14), the client may show a blurred screenshot or redacted
review as a free opening hint. That starting hint is distinct from a hint the
player explicitly requests during the round.

The LiteLLM redaction pipeline writes a resumable JSONL checkpoint first,
imports current hash-matching results into `review_redactions`, and only then
affects `reviewTexts[]` on the next publish. Original review rows remain
available for reprocessing and audit.

## Production storage

The production catalog database must be persisted on the shared application
volume at:

```text
/app/data/catalog/catalog.sqlite
```

All production instances must use that same mounted database. A database
inside the container image or its ephemeral filesystem is not a production
source of truth.

## Commands

```bash
npm run data:catalog-import
npm run data:catalog-status
./scripts/ops/update_difficulty_from_feedback.sh
npm run test:data
```

See `docs/catalog-pipeline.md` and `scripts/README.md` for the complete workflow
and script classification.
