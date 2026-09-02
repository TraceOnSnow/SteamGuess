# Chinese game names and search aliases

## Current source

SteamGuess currently requests Steam Storefront `appdetails` with:

```text
l=schinese&cc=cn
```

When that response contains a title, the normalized catalog stores it in
`localizedNames.zh` and SQLite stores it in `games.name_zh`. Steam publishers
control Storefront localization, so titles from one series may legitimately
mix Chinese, English, trademark symbols, edition suffixes, and different
translation conventions.

The English/US Storefront fallback is metadata-only. It may fill type,
companies, release date, screenshots, or other missing fields, but its title
must never be written into the Chinese-name slot.

## Why Steam data alone is insufficient

Steam does not guarantee that every mainland-China Storefront response has a
Simplified Chinese title. It also does not provide a canonical cross-series
Chinese alias dictionary. Missing or inconsistent Chinese names are therefore
an upstream data limitation, not something that can be corrected safely by
normalizing punctuation or translating strings automatically.

## Recommended alias layer

Keep upstream names immutable and record reviewed aliases through the row-level
provenance JSON. The current canonical display-name fallback is:

```text
manual Chinese primary name
→ Wikidata zh-hans label
→ Wikidata zh label converted to Simplified Chinese
→ verified Steam CN Storefront title
→ English canonical name
```

Wikidata can be joined by Steam Application ID (`P1733`). Imported labels and
aliases should be stored in `field_provenance_json` or a future dedicated
search-alias field with explicit provenance, for example:

```text
field='name_zh', source='manual'
field='name_zh', source='wikidata-label'
field='name_zh', source='wikidata-alias'
```

These values should improve search without overwriting the Steam canonical or
Storefront-localized name. Fuzzy matching against unrelated Chinese game
databases may generate review candidates, but must not directly mutate
canonical data. There is currently no separate alias table.

## Historical data cleanup

Older Storefront state may contain English fallback titles incorrectly recorded
as Chinese. The current fetcher no longer creates that pollution, but old rows
cannot be identified reliably from their text alone. They should be rechecked
against a real `schinese/cn` response or superseded by a source-attributed
`name_zh` value.
