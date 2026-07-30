# SteamGuess catalog schema

The canonical catalog is SQLite-backed. Its versioned schema is
`scripts/catalog/schema.sql`; the generated local database is
`data/catalog/catalog.sqlite`.

## Identity

`apps.appid` is the primary key. Canonical identity and eligibility live in
`apps`; search, answer and labeling membership live in `catalog_memberships`.

## Metadata tables

- `app_names`: localized names by locale, country and source.
- `app_companies`: ordered developers and publishers.
- `app_tags`: ordered tags by source.
- `app_prices`: regional price history; regular and current price are separate.
- `app_media`: headers, screenshots and future media kinds.
- `app_metrics`: timestamped SteamSpy popularity and review observations.
- `app_scores`: recognition and difficulty scores.

## Provenance and refresh state

- `source_batches`: page/file-level fetch metadata, path and SHA-256.
- `source_observations`: per-App source metadata and optional payload JSON.
- `field_provenance`: source currently responsible for each canonical field.
- `enrichment_jobs`: resumable PICS and Storefront work queue.

Null or absent incoming values do not erase known enrichment. Metric and price
rows are historical rather than destructive replacements.

## Runtime database separation

`data/runtime/steamguess.sqlite` stores players, sessions and feedback. It must
not be merged with the catalog database: they have different backup, deployment
and update lifecycles.

## Commands

```bash
npm run data:catalog-import
npm run data:catalog-status
npm run test:data
```

See `docs/catalog-pipeline.md` and `scripts/README.md` for the complete workflow
and script classification.
