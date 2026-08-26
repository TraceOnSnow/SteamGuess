# Chinese game names and search aliases

## Current source

SteamGuess currently requests Steam Storefront `appdetails` with:

```text
l=schinese&cc=cn
```

When that response contains a title, the normalized catalog stores it in
`localizedNames.zh` and SQLite stores it in `app_names`. Steam publishers
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

Keep upstream names immutable and add a separate reviewed alias layer:

```text
manual Chinese primary name
→ Wikidata zh-hans label
→ Wikidata zh label converted to Simplified Chinese
→ verified Steam CN Storefront title
→ English canonical name
```

Wikidata can be joined by Steam Application ID (`P1733`). Imported labels and
aliases should be stored in `app_names` with explicit provenance, for example:

```text
locale='zh-hans', source='manual'
locale='zh-hans', source='wikidata-label'
locale='zh-hans', source='wikidata-alias'
```

These rows should improve search without overwriting the Steam canonical or
Storefront-localized names. Fuzzy matching against unrelated Chinese game
databases may generate review candidates, but must not directly mutate
canonical data.

## Historical data cleanup

Older Storefront state may contain English fallback titles incorrectly recorded
as Chinese. The current fetcher no longer creates that pollution, but old rows
cannot be identified reliably from their text alone. They should be rechecked
against a real `schinese/cn` response or superseded by a source-attributed alias
record.
