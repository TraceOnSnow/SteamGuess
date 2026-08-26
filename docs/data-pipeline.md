# Catalog weekly update

This file is the short operational entry point. The maintained, detailed guide is [`../scripts/CATALOG_PIPELINE.zh-CN.md`](../scripts/CATALOG_PIPELINE.zh-CN.md); avoid duplicating parameter tables here.

## Production command

```bash
./scripts/ops/run_weekly_catalog.sh
```

The wrapper uses `data/catalog/.weekly-work/current/`, checkpoints expensive
work, resumes after interruption, validates the staged release, and only then
atomically replaces the production SQLite database and
`public/games_demo.json`. That JSON is the Search snapshot; rows with a valid
difficulty form the Playable answer pool.

A successful run ends with:

```text
WEEKLY CATALOG READY ...
```

No additional manual import or publish command is required after that line.

## Common configuration

```bash
STEAMGUESS_ACTIVE_LIMIT=1000 \
STEAMGUESS_STEAMSPY_INTERVAL=120 \
STEAMGUESS_STOREFRONT_DELAY=5 \
STEAMGUESS_REVIEWS_DELAY=5 \
./scripts/ops/run_weekly_catalog.sh
```

Use `STEAMGUESS_WEEKLY_FROM_EXISTING=1` to plan/update from the existing candidate catalog without fetching SteamSpy again. Use `STEAMGUESS_WEEKLY_SKIP_ENRICHMENT=1` only for an intentional metadata-free publishing test; it is not a normal complete weekly update.

## Recovery

If a run fails, keep `data/catalog/.weekly-work/current/` and rerun the same command. Do not delete the staging directory unless intentionally abandoning that staged run.

Historical documentation that referred to `/tmp` staging, ten reviews per language, or `labeling_catalog.json` is obsolete.
