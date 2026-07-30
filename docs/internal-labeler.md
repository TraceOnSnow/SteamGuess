# Internal difficulty labeler

## Open

```bash
npm run dev
```

Open the URL printed by Vite and append:

```text
?tool=labeler
```

For a production build, the same query parameter works on the deployed site.

## Fast labeling

- `1`: Easy
- `2`: Normal
- `3`: Hard
- `4`: Hell
- `5`: Exclude
- `S`: Skip without labeling
- `Z`: Undo the latest label

Use **查看分类** to browse Easy, Normal, Hard, Hell, and Excluded lists. Every
row shows its Steam tags and has a selector for moving it to another category or
removing its label.

The four difficulty pools are nested. Choose the earliest pool where the game
should appear. Use **Exclude** for non-games, unusable assets, or candidates that
should never become questions.

## Persistence

Labels are saved only in browser `localStorage`; they are not automatically
written into the Git repository or a server database. If the progress counter
still shows the previous count after refresh, persistence succeeded. Export JSON regularly. Import
merges the file with local labels by App ID; imported values overwrite matching
local values.

The exported file is directly accepted by:

```bash
npm run data:fit -- --labels path/to/difficulty_labels_YYYY-MM-DD.json
```

## Refresh the browser catalog

After regenerating the canonical SteamSpy catalog, publish its compact labeling
copy with:

```bash
npm run data:publish-labeler
```

The labeler contains all 1,999 current candidates. The existing 903-game demo
catalog supplies richer images and tags where available; other games use their
standard Steam header image URL.


## Automatic software exclusion

The labeling catalog is enriched with PICS app types and ordered tags. Apps whose
PICS type is `Application` are automatically labeled as excluded and are never
placed in the random labeling queue. This currently covers 24 software entries.
Legacy PICS `Tool`, `Config`, and `DLC` values are not excluded automatically
because several real games have historically incorrect types.

## Browser-side trial model

After at least 20 non-excluded manual labels exist, the labeler retrains the
small ordinal ridge regression automatically after every edit. The model and
all predictions are stored under `steamguess-difficulty-model-v1` in the same
browser origin, so the main game can use the Easy/Normal/Hard/Hell pools without
a manual JSON export. The original labels remain under
`steamguess-difficulty-labels-v1`; exporting JSON is still recommended as a
portable backup and is required before labels can be committed to Git.

The four playable pools are nested: Easy contains Easy games, Normal contains
Easy + Normal, Hard adds Hard, and Hell contains every non-excluded game in the
current playable catalog.
