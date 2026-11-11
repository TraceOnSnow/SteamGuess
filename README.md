# SteamGuess

**Play:** https://steamguess.traceonsnow.com · [简体中文](README.zh-CN.md) · Made by [TraceOnSnow](https://traceonsnow.com)

Guess a Steam game in ten tries. Search for a game and submit it; the answer is compared with your guess on price, daily peak players, review count, rating, release date, studios and tags. Colours show how close each clue is and arrows show which way the answer lies. A blurred screenshot is available as a hint at any time.

- **Daily challenge** — one game for everyone, new at local midnight.
- **Free play** — pick a difficulty or a themed preset and play as many rounds as you like; share a link to give a friend the same game.
- **Multiplayer rooms** — 2–8 players race on the same game.
- Chinese and English interfaces. Chinese compares mainland prices in CNY; English compares US prices in USD.

## Run it

Requires Node.js 24+.

```bash
npm ci
npm run build
npm start
```

The server listens on `http://localhost:4173`. For development with hot reload use `npm run dev`. A fresh clone works as is: the game data is committed and no API key is needed.

## How the game is put together

| Path | What it is |
| --- | --- |
| `src/` | React client: pages, guess cards, search, screenshot hint |
| `shared/game-rules.js` | Comparison thresholds, tiers and the daily pick, shared by client and server |
| `shared/edition.json` | Sizes of the answer list and of each tier |
| `server/` | Node HTTP server, JSON API, SQLite persistence, Socket.IO rooms |
| `public/games_demo.json` | Every searchable game with its clue data |
| `data/curated/answers.json` | The answer list: which games, at which tier |
| `scripts/catalog/` | One-off Python tools that fetch and rebuild the data |

Routes: `/` home, `/singleplayer` (add `?daily=1` for the daily), `/multiplayer`, `/api/health`.

## Answers and difficulty

About 2,000 games can be searched and guessed; 1,000 of them can be the answer. Tiers are cumulative:

| Tier | Games | Meaning |
| --- | --- | --- |
| Beginner | 20 | Games nearly everyone knows |
| Easy | 50 | Big hits |
| Normal | 100 | Familiar games |
| Hard | 300 | Takes some mileage |
| Hell | 1,000 | Everything, including a long tail nobody has verified |

The daily challenge and multiplayer rooms draw from Hard and below. Hell is single-player only; after a Hell round whose answer comes from the long tail, the player is asked whether it was a fair answer.

Beginner, Easy and Normal are hand-picked for how well Chinese players know the games; Hard starts from a popularity score and is then edited by hand; everything else is Hell. The score comes from a SteamSpy snapshot: `0.85 × log(reviews) + 0.15 × log(concurrent players)`, each normalised to the largest value. Hand-set tiers live in `data/curated/overrides.json`.

Free play can also draw from a preset instead of a tier:

- **TGA nominees**: Game of the Year nominees from the last ten Game Awards that are sold on Steam. The list is `data/curated/tga.json`; add a line after each ceremony.
- **MC 80+**: answers with a Metacritic score of 80 or more, as listed on the Steam store.
- **Custom**: the player pastes or uploads JSON such as `{"name": "My list", "appIds": [730, 570, 292030]}`, or a bare array of AppIDs. It stays in the browser and can be downloaded to share. Games outside the 1,000 answers can be dealt too; they just have no screenshot hint.

Every finished round is stored (answer, outcome, number of guesses, hint use). To see how each answer actually plays:

```bash
npm run db:stats -- --min 10 --level unrated
```

Use that to edit `level` in `data/curated/answers.json` or to remove an entry, then run `npm run data:build`.

## Data

The game data is a frozen snapshot, not a live feed. Sources:

| Source | Provides |
| --- | --- |
| SteamSpy | Which games exist, review counts, concurrent players, user tags |
| Steam Storefront API | Names in both languages, release date, regular prices in USD and CNY, screenshots, studios |
| Steam store page and charts | Review counts and tags for well-known games SteamSpy has no numbers for |
| Hand-kept (`data/curated/`) | Chinese names the store lacks (`zh_names.json`), TGA nominees (`tga.json`), extra games (`supplement.json`) |

Prices are regular prices, never sale prices. A game that is no longer sold in a region shows "Not sold" there. Player counts are a historical figure, not a live count.

To refresh the data (takes about two hours because of rate limits):

```bash
npm run data:fetch             # Storefront data for every game, resumable
npm run data:fetch-supplement  # games listed in data/curated/supplement.json plus Steam's most-played chart
npm run data:build             # rebuild public/games_demo.json; add -- --reselect to redo the answer list
```

Fetch progress is checkpointed under `data/processed/`. Without `--reselect` the existing answer list and tiers are kept.

## Tests and release

```bash
npm run release:check
```

This runs lint, client and server tests, the data-tool tests, a production build and a check that the published data matches `shared/edition.json`. The Redis multiplayer tests are skipped when no Redis is running.

## Deployment

`Dockerfile` builds a single image; `compose.yaml` and `compose.production.yaml` run it with Redis. `.github/workflows/deploy-production.yml` builds and deploys on push. Configuration is in `.env.example`; every variable is optional. Runtime data lives in `data/runtime/steamguess.sqlite` (back it up with `npm run db:backup`).

Not affiliated with Valve. Game images belong to their owners.
