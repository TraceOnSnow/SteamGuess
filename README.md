# SteamGuess

> A data-driven Steam game guessing game — built for daily play, explainable clues, and future multiplayer.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-149eca?logo=react&logoColor=white)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-7-646cff?logo=vite&logoColor=white)](https://vite.dev/)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-5fa04e?logo=node.js&logoColor=white)](https://nodejs.org/)

[简体中文](README.zh-CN.md)

SteamGuess is a Wordle-like web game for identifying Steam games from structured clues. Search by a Chinese or English title, submit a guess, and progressively narrow the answer using price, player activity, review metrics, release date, companies, and Steam user tags.

The project is intentionally split into two layers:

- **Playable experience** — a fast browser catalog used by players.
- **Data and feedback platform** — a persistent catalog, enrichment jobs, difficulty feedback, and the foundation for multiplayer.

## Product surface

| Entry | Description |
| --- | --- |
| `/` | Mode selection: single-player or multiplayer |
| `/singleplayer` | Main guessing game with configurable clue fields and hints |
| `/multiplayer` | Private room, same-question race for 2–8 players |
| `/labeler` | Internal difficulty-labeling tool; disabled in production by default |
| `/api/health` | Service health check |

### Highlights

- Chinese/English game-name search with keyboard navigation.
- Ten-guess single-player loop with duplicate-guess prevention.
- Four preset difficulty pools: Easy, Normal, Hard, and Hell.
- Custom pools from uploaded AppIDs or a public Steam profile.
- Mainland-China regular prices in CNY; promotional prices are deliberately excluded from statistics.
- Seven-day player peak when samples are available; SteamSpy's `ccu` is treated as a historical peak, not live online count.
- Screenshot and review hints when the catalog already contains the required source data.
- Post-game difficulty feedback on a 0–100 scale or through preset levels.
- Server-side persistence for sessions, outcomes, and feedback.
- Multiplayer room codes with one-click copy, ready checks, server-authoritative rounds, surrender, rematch, and reconnect support.

## Architecture

```text
SteamSpy request=all ─┐
Steam Storefront API ─┼─> catalog JSON ─> catalog SQLite ─> playable artifacts ─> web client
Steam Reviews API ────┤              └─> enrichment checkpoints
Steam PICS (optional) ┘

web client ──HTTP API──> Node.js service ──> runtime SQLite
             Socket.IO ─> multiplayer room engine
```

| Area | Location | Responsibility |
| --- | --- | --- |
| Frontend | `src/` | React UI, game engine, search, hints, settings, multiplayer client |
| HTTP/API server | `server/` | Static serving, API routes, rate limits, migrations, runtime persistence |
| Catalog pipeline | `scripts/catalog/` | Discovery, normalization, enrichment, publishing, import, status |
| Operations | `scripts/ops/` | Production weekly runner, release validation, backup and smoke tools |
| Public artifacts | `public/` | Browser-ready game and labeling catalogs |
| Documentation | `docs/` | Pipeline, schema, labeler, multiplayer research and operations |

The catalog database and player/runtime database are separate. This keeps a catalog refresh independent from player sessions and feedback.

## Quick start

Requirements: Node.js 24+, npm, and Python 3.12+ for catalog tooling.

```bash
npm ci
npm run dev
```

Open the Vite URL and start at `/`. To run the production-shaped server locally:

```bash
npm run build
npm start
```

The default server listens on `0.0.0.0:4173`.

## Quality gates

Run the full local release gate before deployment:

```bash
npm run release:check
```

It covers frontend linting, frontend/backend tests, data-pipeline tests, TypeScript compilation, production build, and deployment preflight checks. Useful focused commands:

```bash
npm run lint
npm test
npm run test:data
npm run build
npm run release:preflight
```

## Catalog workflow

The current catalog is a checked-in browser snapshot. The intended weekly workflow is incremental and resumable:

1. Fetch SteamSpy `request=all` pages `0..19` (the top 20 pages).
2. Normalize and deduplicate by unique AppID.
3. Keep the first `6,000` games active; retain later candidates as reserve data.
4. Enrich only active games that are missing completed PICS, Storefront, or review jobs.
5. Save raw pages and enrichment state as checkpoints.
6. Publish browser artifacts, validate consistency, and import the catalog SQLite snapshot atomically.
7. Preserve the previous successful snapshot and staging directory on failure.

The production entry point is:

```bash
./scripts/ops/run_weekly_catalog.sh
```

Important defaults:

```text
SteamSpy pages:              0..19
Delay between SteamSpy pages: 120 seconds
Storefront delay:            5 seconds
Reviews delay:               5 seconds
SteamSpy retries:            2
Review retries:              3
Active catalog limit:        6,000
```

A failed run can be resumed by running the same command again. Staging is kept at `data/catalog/.weekly-work/current`. Relevant overrides include:

```bash
STEAMGUESS_ACTIVE_LIMIT=6000
STEAMGUESS_STEAMSPY_INTERVAL=120
STEAMGUESS_STEAMSPY_RETRIES=2
STEAMGUESS_STEAMSPY_RETRY_DELAY=30
STEAMGUESS_STOREFRONT_DELAY=5
STEAMGUESS_REVIEWS_DELAY=5
STEAMGUESS_REVIEWS_RETRIES=3
STEAMGUESS_REVIEWS_RETRY_DELAY=30
```

For a dry plan from an existing catalog:

```bash
STEAMGUESS_WEEKLY_FROM_EXISTING=1 \
STEAMGUESS_WEEKLY_SKIP_ENRICHMENT=1 \
./scripts/ops/run_weekly_catalog.sh
```

Further details: [`docs/data-pipeline.md`](docs/data-pipeline.md), [`docs/catalog-pipeline.md`](docs/catalog-pipeline.md), and [`docs/data-schema.md`](docs/data-schema.md).

## Database and operations

Schema changes are tracked through `schema_migrations`. The server refuses to open a database newer than the schema it supports.

```bash
npm run db:backup
npm run db:stats
npm run data:catalog-status
```

Persist `data/` in production, schedule backups, copy backups off-host, and perform a real restore drill before launch. Docker Compose is available for a deployment-shaped setup:

```bash
docker compose up -d --build
docker compose ps
```

## Configuration and security

```bash
cp .env.example .env
```

`STEAM_WEB_API_KEY` is server-only and is used for public Steam profile/library imports. It is not required for the catalog's review endpoint. Never put it in frontend code or commit it to Git.

The service applies request size limits, write/profile-import rate limits, upstream timeouts, security headers, and SQLite migrations. Set `STEAMGUESS_TRUST_PROXY=true` only when the service is behind a trusted reverse proxy. The internal labeler requires an explicit production build flag:

```env
VITE_LABELER_ENABLED=false
```

## Multiplayer status

The multiplayer MVP supports private rooms for 2–8 players, BO1/BO3/BO5, ready checks, room-code sharing, server-authoritative answer selection and scoring, round timers, surrender, rematch, and short reconnect recovery.

Active rooms currently live in one Node.js process. A process restart ends active rooms, so production should remain single-instance until a shared room store (for example Redis) is introduced. Leaderboards, matchmaking, and durable room recovery are intentionally out of scope for the current release.

See [`docs/multiplayer-research.md`](docs/multiplayer-research.md) for the implementation direction.

## Roadmap

- [x] Single-player guessing loop and difficulty pools
- [x] Persistent player feedback and catalog database
- [x] Resumable weekly catalog staging
- [x] Screenshot/review hint interfaces
- [x] Multiplayer MVP foundation
- [ ] More complete Chinese metadata and review coverage
- [ ] Shared multiplayer room state and durable reconnects
- [ ] Matchmaking, rankings, and social features

## License and data attribution

SteamGuess code and generated data are maintained separately. Steam metadata, images, tags, and reviews remain subject to their respective providers' terms and copyrights. Do not redistribute upstream data without checking the applicable terms.
