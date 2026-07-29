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

The four difficulty pools are nested. Choose the earliest pool where the game
should appear. Use **Exclude** for non-games, unusable assets, or candidates that
should never become questions.

## Persistence

Labels are saved only in browser `localStorage`. Export JSON regularly. Import
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
