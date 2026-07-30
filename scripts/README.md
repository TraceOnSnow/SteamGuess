# SteamGuess scripts

The script directory is split by responsibility. New data-pipeline work belongs
in `scripts/catalog/`; do not add another one-off fetcher at the root.

## Current catalog pipeline — `scripts/catalog/`

| Script | Stage | Network | Status |
|---|---|---:|---|
| `discover_steamspy.py` | SteamSpy `request=all` discovery and popularity scoring | Yes, unless `--from-raw` | Current |
| `database.py` / `schema.sql` | Canonical SQLite connection and schema | No | Current |
| `import_current.py` | Idempotent bootstrap/upsert from the current JSON catalogs | No | Current |
| `status.py` | Completeness and enrichment queue report | No | Current |
| `enrich_pics.py` | Merge an existing PICS snapshot into JSON | No | Transitional adapter |
| `enrich_storefront.py` | Resumable Storefront localized-name/CN-price fetch | Yes | Transitional adapter |
| `enrich_cn_prices.py` | Storefront multi-App CN price utility | Yes | Transitional utility |
| `refresh_metrics.py` | SteamSpy daily peak sample and rolling seven-day peak | Yes | Current |
| `fit_difficulty.py` | Lightweight difficulty regression | No | Current |
| `publish_labeling.py` | Publish the internal labeling JSON | No | Current |
| `publish_playable.py` | Publish the browser answer/search JSON | No | Current |
| `common.py` | Shared company-name normalization | No | Current |

“Transitional” means the script still updates the normalized JSON catalog. The
next pipeline stage should make PICS and Storefront workers write source
observations and canonical fields directly to `catalog.sqlite`.

## Operations — `scripts/ops/`

- `backup_database.mjs`: consistent runtime/player database backup.
- `feedback_stats.mjs`: player-session and difficulty-feedback statistics.
- `preflight.mjs`: production release checks.

These scripts operate on the website runtime database, not the catalog database.
Keep `data/runtime/steamguess.sqlite` and `data/catalog/catalog.sqlite` separate.

## Experimental — `scripts/experimental/`

- `pics-poc/`: anonymous PICS proof of concept.
- `PICS_TAGS_POC.md`: experiment notes.

Experimental code is not installed in the production image and must not become
a production dependency accidentally.

## Legacy — `scripts/legacy/`

The files here belong to the older SteamSpy/Storefront JSONL pipeline. They are
retained only as reference material and are not called by `package.json` or the
current `Makefile`. They may depend on packages that are no longer installed.

## Main commands

```bash
npm run data:catalog-import   # bootstrap/upsert current 1,999 records into SQLite
npm run data:catalog-status   # inspect completeness and pending work
npm run data:discover         # refresh the current page 0/1 snapshot
npm run data:discover-weekly  # fetch request=all pages 0..19 (slow; not run in CI)
npm run data:update-weekly    # discover 20 pages, then upsert them into SQLite
npm run test:data
```

`data/catalog/catalog.sqlite` and the listed bootstrap raw snapshots are versioned so another host can continue without refetching them. New raw snapshots remain ignored by default; persist and back them up on the deployment host.
