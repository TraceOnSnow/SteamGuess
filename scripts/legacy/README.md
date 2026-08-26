# Retired scripts

Everything in this directory is historical reference code. It is **not** part
of the supported SteamGuess data pipeline and must not be used to update the
canonical database.

Use these maintained entry points instead:

```text
Weekly catalog update     scripts/ops/run_weekly_catalog.sh
Difficulty feedback       scripts/ops/update_difficulty_from_feedback.sh
Catalog status            python -m scripts.catalog.status
```

The scripts here predate one or more current guarantees:

- `data/catalog/catalog.sqlite` is the canonical catalog and difficulty store;
- expensive network work is checkpointed and resumable;
- publication is staged, validated, and atomic;
- `public/games_demo.json` is generated rather than edited as authority;
- the old curated-pool and browser-local labeling workflows are retired.

They remain only for reproducing old analyses or understanding historical raw
formats. If old behavior is needed again, port the required behavior into
`scripts/catalog/` with tests instead of calling these scripts from production.
