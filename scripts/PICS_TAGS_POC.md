# PICS store-tags proof of concept

This script anonymously connects to Steam, fetches PICS AppInfo for a small set
of App IDs, reads `appinfo.common.store_tags`, and resolves the numeric IDs with
Steam's `Store.GetLocalizedNameForTags` service.

It is intentionally a validation tool, not the production data pipeline.

## Run

```bash
# Built-in sample: CS2, ELDEN RING, Baldur's Gate 3
npm run pics:tags

# Explicit App IDs
npm run pics:tags -- 730 1245620 1086940

# Read the repository's candidate list, but only test 10 entries
npm run pics:tags -- \
  --file data/processed/appids_inter_20260225.json \
  --limit 10 \
  --out /tmp/pics-tags.json

# Resolve localized Simplified Chinese tag names
npm run pics:tags -- 730 --language schinese
```

The JSON result preserves PICS tag ordering through the `rank` field and includes
both the requested localized name and Steam's English name when available.

## Notes

- No Steam account or Web API key is required; the script logs in anonymously.
- Anonymous PICS works in the current test. If Steam rejects the unified tag-name lookup, the script automatically uses the public Storefront tag dictionary.
- The script disables `steam-user`'s persistent data directory.
- Some unreleased or restricted apps may return `missingToken: true`.
- Keep the first test small. This script proves data availability and shape; it
  does not yet implement production caching, change-number synchronization,
  retries, or durable checkpoints.
