# Persistent catalog pipeline

## 1. Source of truth

`data/catalog/catalog.sqlite` is the canonical metadata store. Because the live database exceeds GitHub’s per-file limit, the versioned bootstrap snapshot is stored as `data/catalog/catalog.sqlite.gz` together with `data/catalog/bootstrap-manifest.json`, so development can move to another host without repeating the existing fetches. Steam App ID is
the only application identity:

```sql
apps.appid INTEGER PRIMARY KEY
```

The website runtime/player database remains a separate file at
`data/runtime/steamguess.sqlite`.

## 2. Discovery

The weekly discovery command fetches SteamSpy `request=all` pages 0 through 19
and writes both timestamped raw page envelopes and a normalized candidate
snapshot:

```bash
npm run data:discover-weekly
```

SteamSpy supplies candidate discovery, owners, reviews, playtime and the
previous day's peak CCU. Discovery does not imply that an App becomes an answer.

## 3. Persistence and provenance

The SQLite catalog stores canonical values in normalized tables and keeps:

- field-level provenance;
- source batches and per-App source observations;
- raw file path and SHA-256 when available;
- metric and price history;
- PICS change numbers;
- enrichment queue state.

Imports do not replace known tags, companies, dates or media with missing values.

## 4. Eligibility

Catalog memberships are independent:

- `discovery`: App was observed in the SteamSpy candidate set;
- `search`: user may find and submit the App in the search box;
- `playable`: App may be selected as the answer;
- `labeling`: App is visible in the internal difficulty tool.

A future eligibility worker should use PICS type, valid names, popularity
thresholds, explicit exclusions and manual allowlists. DLC, demos, tools,
servers, soundtracks and other non-games must not enter `search` or `playable`.

## 5. Enrichment

Only eligible candidates should receive expensive per-App requests:

1. PICS for type, ordered user tags and change number.
2. Storefront English for stable name, release date, companies and screenshots.
3. Storefront Simplified Chinese with `cc=cn` for Chinese name, mainland-China
   availability and regular CNY price.

The bootstrap creates `enrichment_jobs`. Existing completeness currently leaves
most work in `storefront/english/us`, which corresponds to the known missing
release dates and screenshots.

## 6. Publishing

Browser JSON files remain deployment artifacts rather than the source of truth:

- `search_catalog.json` — future larger searchable set;
- `games_demo.json` — current answer pool;
- `labeling_catalog.json` — internal labeling set.

The current publishers still read the normalized JSON snapshot. A later bounded
change should publish directly from SQLite after the eligibility worker exists.

## 7. Bootstrap and inspection

After a fresh clone, restore the canonical database snapshot once:

```bash
gzip -dk data/catalog/catalog.sqlite.gz
```

The generated `catalog.sqlite` stays ignored by Git; weekly runs update it in place.

```bash
npm run data:catalog-import
npm run data:catalog-status
```

The import is idempotent and merges richer retained fields from
`public/games_demo.json`, including the 890 existing release dates and
screenshots.

## 8. Weekly sequence

Current safe sequence:

```text
SteamSpy raw pages 0..19
→ normalized discovery snapshot
→ SQLite upsert without erasing enrichment
→ eligibility queue (next implementation stage)
→ PICS / Storefront workers (next implementation stage)
→ SQLite-backed publishers (next implementation stage)
```

Do not schedule the expensive enrichment workers until their retry, checkpoint,
rate-limit and failure-state behavior has been verified on a small batch.
