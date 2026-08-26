# SteamGuess scripts

The maintained Chinese operator guide is [`CATALOG_PIPELINE.zh-CN.md`](./CATALOG_PIPELINE.zh-CN.md). New production data work belongs in `scripts/catalog/`; one-off experiments belong in `scripts/experimental/`.

## Current catalog pipeline

| Script | Responsibility | Network |
|---|---|---:|
| `discover_steamspy.py` | SteamSpy `request=all` discovery, raw checkpoints, normalization | Yes unless `--from-raw` |
| `database.py` / `schema.sql` | Canonical SQLite connection, schema, migrations | No |
| `update_weekly.py` | Orchestrate planning, enrichment, import and publishing in a staged workspace | Depends on options |
| `import_current.py` | Idempotently upsert normalized JSON and runtime snapshot into SQLite | No |
| `enrich_pics.py` | Merge a prepared PICS snapshot | No |
| `enrich_storefront.py` | Resumable localized Storefront metadata enrichment | Yes |
| `enrich_reviews.py` | Resumable English/Simplified-Chinese review enrichment | Yes |
| `publish_playable.py` | Publish the single/multiplayer Search snapshot; scored rows form the answer pool | No |
| `update_difficulty_from_feedback.py` | Validate runtime feedback and update catalog-side feedback scores/history | No |
| `export_difficulty_ai_input.py` | Export objective playable metadata for independent AI scoring | No |
| `status.py` | Report catalog completeness and pending enrichment | No |
| `redact_reviews_ai.py` | Provider-agnostic LiteLLM review cleaning with resumable JSONL checkpoints | Yes except `--dry-run` |
| `import_review_redactions.py` | Import current hash-matching redactions into the SQLite sidecar | No |

## Operations

```bash
./scripts/ops/run_weekly_catalog.sh  # safe resumable weekly release
./scripts/ops/update_difficulty_from_feedback.sh # runtime feedback → catalog
npm run data:catalog-status          # inspect SQLite completeness
npm run data:export-difficulty-ai    # rebuild the AI scoring input from SQLite
npm run test:data                    # pipeline unit tests
```

The weekly wrapper owns locking, persistent staging, resume, validation,
backups and atomic publication. `STEAMGUESS_ACTIVE_LIMIT` controls the runtime
rank window, while `STEAMGUESS_DETAIL_LIMIT` controls the wider
metadata-enrichment window. The published relationships are:

```text
Playable answers ⊆ Search guesses ⊆ Active rank window
```

An explicit AI `eligible=false` decision removes software/noise from Search and
Playable. Missing AI candidates remain searchable but cannot become answers.
Missing PICS rows are fetched anonymously in durable chunks. A completed weekly
run requires no second manual import.

## Difficulty data

The admin page reads and writes `data/catalog/catalog.sqlite` through the
server API. `difficulty_ai_candidates` contains baseline scores and eligibility,
and `difficulty_overrides` contains manual scores and locks.
`public/games_demo.json` is the generated Search snapshot. Its rows with valid
`difficulty` objects form the Playable answer pool.

Player feedback is retained in `data/runtime/steamguess.sqlite` and synchronized
into `difficulty_feedback_scores` / `difficulty_feedback_history` with:

```bash
./scripts/ops/update_difficulty_from_feedback.sh
```

The effective published priority is:

```text
locked manual override > player feedback score > eligible AI candidate
```

`catalog_exclusions` contains durable editorial removals (`unsuitable` or
`too_obscure`). Weekly selection and publishing skip these AppIDs before
applying the active limit, allowing the next ranked eligible games to fill the
vacated slots.

The former generated labeling catalog and browser-local scoring path have been
removed and must not be reintroduced.

The AI scoring input is generated at
`data/analysis/difficulty-ai-v2/input.json`. It contains objective candidate
metadata: names, companies, tags, release dates, mainland-China regular prices,
and latest SteamSpy metrics. It deliberately excludes existing difficulty
scores, previous AI candidates, reviews, and discounted prices.

## Beginner and opening hints

`beginner` is the strict 0–14 difficulty tier. It may start a round with a free
blurred screenshot or redacted review. This opening material is part of the
mode setup and is distinct from a hint explicitly requested by the player.

Runtime hint arrays are:

```text
hints.screenshotUrls[]
hints.reviewTexts[]
```

## AI review redaction

The maintained AI workflow is a sidecar:

```bash
STEAMGUESS_REDACTION_MODEL=provider/model \
STEAMGUESS_REDACTION_SCOPE=detail \
STEAMGUESS_REDACTION_IMPORT_DB=data/catalog/catalog.sqlite \
./scripts/ops/run_review_redaction_ai.sh
```

LiteLLM is imported lazily and provides a provider-agnostic adapter. The runner
writes an append-safe, resumable JSONL checkpoint. Import validates the source
review hash and stores successful output in `review_redactions` without
overwriting `app_reviews`. The next `publish_playable.py` run resolves matching
sidecars into `hints.reviewTexts[]`.

## Runtime database

Operations such as `backup_database.mjs` and `feedback_stats.mjs` target `data/runtime/steamguess.sqlite`, which is intentionally separate from the catalog database.

## Production catalog volume

Production must persist the shared canonical catalog at:

```text
/app/data/catalog/catalog.sqlite
```

All application instances must mount and read that same path. Do not treat a
database embedded in an image or stored only in a container's writable layer
as durable production state.

## Experimental and legacy

- `scripts/experimental/`: proofs of concept, including anonymous PICS research; not production dependencies.
- [`scripts/legacy/`](./legacy/README.md): retired older fetch pipelines kept as
  reference only. They are not called by `package.json`, the Makefile, or the
  weekly runner and may depend on uninstalled packages.
