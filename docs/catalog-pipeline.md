# Persistent catalog architecture

## Source of truth

`data/catalog/catalog.sqlite` is the canonical metadata and difficulty store. Steam App ID is the unique identity:

```sql
apps.appid INTEGER PRIMARY KEY
```

The runtime/player database is separate:

```text
data/catalog/catalog.sqlite       game catalog, enrichment, difficulty
data/runtime/steamguess.sqlite    players, sessions, feedback
```

JSON files are import or deployment artifacts, not independent databases.

## Current data flow

```text
SteamSpy request=all pages
  → staged normalized candidate catalog
  → restore retained metadata from catalog.sqlite
  → enrich the configured detail window (PICS, Storefront, Reviews)
  → import/upsert catalog.sqlite
  → publish public/games_demo.json
  → refresh SQLite memberships
  → validate
  → atomically replace the production catalog and snapshot
```

The authoritative runtime snapshot is:

```text
public/games_demo.json
├── Search catalog: every published row can be searched and submitted as a guess
└── Answer pool: only rows carrying a valid difficulty can be selected as answers
```

There is no separate labeling JSON. The difficulty manager uses admin APIs to read and write SQLite directly.

## Catalog responsibilities

SQLite retains:

- canonical apps and localized names;
- developers and publishers;
- ordered PICS user tags;
- regular regional prices (not current discount prices);
- media, including all available screenshots;
- SteamSpy metrics and history;
- English and Simplified Chinese review snapshots;
- AI-redacted review sidecars without overwriting the original reviews;
- enrichment job state and source provenance;
- AI difficulty candidates and eligibility, player-feedback aggregates, manual
  overrides, and locks.

Memberships currently used by the application are:

- `active`: the SteamSpy rank window after durable editorial exclusions;
- `search`: Active rows that can be searched and submitted as guesses;
- `playable`: Search rows with an authoritative difficulty that can be selected
  as answers.

The required subset relationship is:

```text
playable ⊆ search ⊆ active
```

A historical `labeling` membership may be deleted during import, but no current
feature creates or consumes it.

## Publishing rules

`publish_playable.py` is a historical filename. It now builds the Search
snapshot `games_demo.json` from the normalized catalog and persistent SQLite
metadata. A Search row may omit difficulty. A row becomes Playable only when it
has a legal 0–100 score and one of `beginner`, `easy`, `normal`, `hard`, or
`hell`. `beginner` is the strict 0–14 tier.

Active selection skips AppIDs in `catalog_exclusions` before applying
`active_limit`, so a lower-ranked eligible game fills each excluded slot.
Exclusions survive weekly imports; restoring a game only makes it eligible for
the next selection rebuild.

`STEAMGUESS_DETAIL_LIMIT` is independent from `STEAMGUESS_ACTIVE_LIMIT`.
The default production shape enriches the first 4000 eligible SteamSpy rows
while publishing only the first 1000 as Active. Anonymous PICS requests are
checkpointed in 500-AppID chunks inside the staged workspace.

Candidate order is the original SteamSpy `request=all` page and response order.
No derived popularity or difficulty score reorders the discovery catalog.

Difficulty eligibility is evaluated after the Active rank window is fixed:

- `eligible = false`: software, tools, noise, or unsuitable rows are omitted
  from both Search and Playable;
- `eligible = true`: the candidate score gives the row a difficulty, so it
  enters both Search and Playable;
- no AI candidate: the row remains in Search, but cannot be selected as an
  answer until an authoritative difficulty exists.

This prevents unreviewed rows from silently becoming zero-score questions while
still allowing them to be submitted as guesses. Weekly Steam metadata refreshes
do not invoke AI scoring; reevaluation is an explicit, separate operation.
PICS `type` remains metadata rather than a hard publication filter because
normal games can be reported as `Tool`, `Config`, or `advertising`.

Manual difficulty management follows:

```text
eligible AI candidate → accepted player feedback → locked manual override
                                                     ↓
                                            effective answer difficulty
```

A locked manual score is the public effective value. An unlocked manual score
is an editor draft and does not affect play.

Validated player feedback is synchronized from the runtime database into the
catalog database with:

```bash
./scripts/ops/update_difficulty_from_feedback.sh
```

The effective public score has one explicit precedence order:

```text
locked manual override > player feedback score > eligible AI candidate
```

The synchronization job uses only the latest valid response for each
player/game pair, applies sample and variance gates, and limits each accepted
adjustment. It writes `difficulty_feedback_scores` plus an append-only
`difficulty_feedback_history`; publishing then materializes the effective
score into `games_demo.json`.

## Starting hints

The `beginner` tier covers scores 0–14. A round may start with one free hint:
either a blurred screenshot or a redacted review. This opening hint is part of
the selected game mode and is not counted as a player-requested hint. Later
hints opened from the hint menu remain explicit player actions.

Published hint data uses arrays:

```text
hints.screenshotUrls[]   all available screenshot URLs
hints.reviewTexts[]      publishable redacted review text
```

## AI review-redaction sidecar

`redact_reviews_ai.py` uses a lazily loaded, provider-agnostic LiteLLM adapter.
It writes resumable JSONL checkpoints and never mutates the source reviews.
Successful records can be imported into the SQLite `review_redactions` sidecar
table:

```bash
STEAMGUESS_REDACTION_MODEL=provider/model \
STEAMGUESS_REDACTION_SCOPE=detail \
STEAMGUESS_REDACTION_IMPORT_DB=data/catalog/catalog.sqlite \
./scripts/ops/run_review_redaction_ai.sh
```

The importer verifies the review hash so stale output cannot replace a changed
review. During publication, matching sidecar text is preferred and emitted as
`hints.reviewTexts[]`; the original `app_reviews` rows remain intact.

## Production persistence

Production must keep the canonical catalog database on the shared persistent
volume at:

```text
/app/data/catalog/catalog.sqlite
```

Do not rely on a temporary catalog database baked into or created inside an
individual container. Every application instance must mount and read the same
catalog database path so weekly metadata, difficulty feedback, locks, and
review redactions survive image replacement and remain consistent.

## Commands

```bash
./scripts/ops/run_weekly_catalog.sh   # resumable transactional weekly update
./scripts/ops/update_difficulty_from_feedback.sh # synchronize player feedback
npm run data:catalog-status           # inspect canonical database
npm run db:backup-catalog             # consistent local catalog backup
npm run test:data                     # data-pipeline tests
```

The retired `catalog.sqlite.gz` repository bootstrap must not be restored: it
contained an older schema, old Labeler memberships, and an obsolete 997-game
snapshot. Catalog databases move between hosts through explicit backups or
persistent-volume restores, not Git.

The detailed operator guide is [`../scripts/CATALOG_PIPELINE.zh-CN.md`](../scripts/CATALOG_PIPELINE.zh-CN.md). Difficulty administration is documented in [`internal-labeler.md`](internal-labeler.md).
