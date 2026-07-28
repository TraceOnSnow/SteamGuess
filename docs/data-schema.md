# SteamGuess catalog schema

The catalog uses one normalized record per Steam App ID. Raw API responses stay in
`data/raw/`; normalized candidates and published snapshots use the schema in
`data/schema/game-catalog.schema.json`.

## Stable identity and metadata

- `appId`: Steam App ID and merge key.
- `name`, `type`, `releaseDate`, `developers`, `publishers`, `tags`: stable-ish
  metadata, preferably refreshed from PICS.
- `assets` and `price`: regional Storefront data; these may be absent during the
  SteamSpy-only discovery stage.

## Popularity and recognition

- `metrics`: raw SteamSpy popularity/review/playtime values.
- `recognition.score`: 0–100; larger means more likely to be recognized.
- `difficulty.score`: 0–100; larger means harder. Initially this is
  `100 - recognition.score`.
- `difficulty.level`: one of `easy`, `normal`, `hard`, `hell`.
- `difficulty.source`: `heuristic`, `regression`, or `manual`.
- `difficulty.excluded`: removes unsuitable apps from every built-in pool.

The four pools are nested. A game assigned `easy` is also present in normal,
hard and hell; a `normal` game is also present in hard and hell.

## Manual labels and regression

Manual labels are authoritative. The lightweight regression script maps labels
to ordinal targets (`easy=0`, `normal=1`, `hard=2`, `hell=3`) and fits a small
ridge-regularized linear regression implemented with the Python standard
library. It is deliberately not a machine-learning framework.

Until enough labels exist, the pipeline uses a transparent popularity heuristic.
The same percentile-normalized popularity features are persisted so the catalog
can later be rescored without refetching SteamSpy.

## Provenance

Every record contains `sources` entries with service, endpoint and retrieval
time. `fieldSources` says which source owns each field group. The intended merge
policy is:

- SteamSpy: candidate discovery and popularity/review/playtime metrics.
- PICS: app type, ordered store tags, names and stable metadata.
- Storefront: regional price, screenshots and store assets.
- Manual: final difficulty overrides and exclusions.

## Commands

```bash
# Fetch SteamSpy page 0 and page 1, then normalize and score about 2,000 rows
npm run data:discover

# Rebuild from the newest ignored raw snapshots without network access
npm run data:normalize

# After copying the example label file and adding at least 20 real labels
npm run data:fit -- --labels data/labels/difficulty_labels.json

# Pipeline unit tests
npm run test:data
```

SteamSpy is currently protected by a Cloudflare browser challenge on some IPs.
The fetcher tries the official API first, then uses `r.jina.ai` only as a
read-only transport fallback. The original SteamSpy endpoint and the transport
are both recorded in provenance. Raw responses are ignored by Git; the
normalized catalog is versioned.
