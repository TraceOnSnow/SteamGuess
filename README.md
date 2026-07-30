# SteamGuess

SteamGuess is a Wordle-like browser game for Steam titles. Players have ten attempts and use mainland-China regular price, player peaks, review metrics, release date, companies, and user tags to identify the answer.

## 1. Features

- **1,964 playable `type=game` titles** and 1,999 internal labeling candidates.
- Chinese/English title search, keyboard navigation, duplicate-guess prevention, and custom AppID pools.
- Configurable clue fields: price, activity, rating, release date, ownership, companies, and tags.
- Screenshot hints only when `hints.screenshotUrl` already exists in the catalog.
- Post-game 0–100 difficulty feedback with preset levels.
- Local AppID import and server-side import of public Steam libraries.

## 2. Stack and layout

- React 19, TypeScript 5.9, Vite 7, i18next.
- Node.js HTTP service and Node's built-in SQLite.
- `public/games_demo.json`: 1,964-game playable catalog.
- `public/labeling_catalog.json`: 1,999 internal candidates.
- `server/`: API, rate limiting, migrations, and static serving.
- `data/runtime/`: persistent, untracked runtime database.

The internal labeler is available in development and disabled in production unless the build explicitly sets `VITE_LABELER_ENABLED=true`.

## 3. Development and checks

```bash
npm ci
npm run dev
```

Run the complete release gate with:

```bash
npm run release:check
```

This runs lint, frontend/backend tests, data tests, a production build, and preflight validation.

## 4. Production deployment

```bash
cp .env.example .env
npm ci
npm run build
npm start
```

The server defaults to `0.0.0.0:4173`; health is exposed at `/api/health`. Docker Compose is also provided:

```bash
docker compose up -d --build
docker compose ps
```

Persist `/app/data`. Only enable `STEAMGUESS_TRUST_PROXY=true` behind a trusted reverse proxy. See `.env.example` for the Steam Web API key, SQLite path, rate limits, logging, and build-time labeler switch.

## 5. Catalog refresh

The current 1,999 SteamSpy candidates publish to **1,964 playable games** after non-game records are removed. The published catalog contains 1,963 Chinese names, 1,704 mainland-China regular prices, and 890 retained screenshots.

```bash
npm run data:catalog-import    # bootstrap/upsert the canonical catalog SQLite database
npm run data:catalog-status    # inspect completeness and pending enrichment
npm run data:publish-labeler   # offline browser artifact publish
npm run data:publish-playable  # offline browser artifact publish
npm run data:sample-peaks      # daily SteamSpy peak sample
npm run data:update-weekly     # fetch SteamSpy pages 0..19 and upsert discovery
```

The persistent catalog database is separate from the player/runtime database; see `docs/catalog-pipeline.md`. SteamSpy `ccu` is the previous day's peak, not a live count. The UI uses a rolling seven-day peak when sample history exists. Prices use mainland-China regular prices only, never promotional prices or converted USD values.

The experimental PICS dependency is isolated from the production project:

```bash
npm run pics:install
npm run pics:tags -- 730 --language schinese
```

## 6. SQLite operations

Schema changes run through the `schema_migrations` table. A server refuses to open a database newer than the schema version it supports.

```bash
npm run db:backup  # consistent VACUUM INTO backup; keeps 14 by default
npm run db:stats   # players, sessions, outcomes, and difficulty feedback
```

Persist `data/runtime/`, schedule backups, copy backups off-host, and test an actual restore before launch.

## 7. Security

- POST writes are limited to 60 requests/IP/minute; Steam profile imports to 12.
- JSON request bodies are limited to 32 KB and Steam upstream calls time out after 12 seconds.
- Production responses include CSP, MIME-sniffing protection, frame denial, Referrer Policy, and Permissions Policy.
- `STEAM_WEB_API_KEY` is server-only. Steam game details must be public for library import.
- The ignored root `token` must never be committed; rotate any credential that has appeared in Git history.
- The isolated PICS PoC has upstream audit warnings, but is absent from the main dependency tree and production runtime image. The main project audit is clean.

## 8. Launch checklist

1. Configure HTTPS, domain, reverse proxy, and the Steam Web API key.
2. Verify `/app/data` survives a container rebuild.
3. Run `npm run release:check` and request `/api/health`.
4. Test Chinese search, catalog loading, custom AppIDs, and public-library import.
5. Test screenshot/no-screenshot hints and unknown price/date rendering.
6. Schedule database backups and weekly catalog refreshes.
7. Monitor 429/502 responses, feedback failures, database growth, and page load time.
8. Keep leaderboard and multiplayer deferred while retaining the player/session foundation.
