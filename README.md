# SteamGuess

SteamGuess is a Wordle-like browser game for Steam titles. Players get ten attempts and use feedback about price, current players, review count, positive rate, release date, and shared tags to identify the hidden game.

The current version focuses on a reliable frontend baseline. It uses the 903 games in `public/games_demo.json`; the experimental Python data-fetching pipeline is intentionally outside the current maintenance scope.

## Features

- Random answer from a 903-game catalog
- Keyboard-accessible title search
- Duplicate guesses excluded
- Ten attempts per game
- Tiered numeric and date feedback with unambiguous direction arrows
- Shared-tag highlighting
- Win, loss, and reveal-answer states without blocking browser alerts
- Chinese and English UI with persisted language preference
- Responsive layout and baseline accessibility support
- Steam Store links from each game cover

## Stack

- React 19
- TypeScript 5.9
- Vite 7
- i18next / react-i18next
- date-fns
- Vitest
- ESLint 10

There is currently no backend. The catalog is loaded as static JSON when the app starts.

## Development

```bash
npm ci
npm run dev
```

Quality checks:

```bash
npm run lint
npm run test
npm run build
npm run preview
```

## Architecture

```text
public/games_demo.json
        ↓ fetch
      App.tsx
        ↓
    SearchBox
        ↓
ComparisonEngine + FieldComparator
        ↓
   GuessRecord[]
        ↓
    GameTable
```

Key files:

- `src/App.tsx`: catalog loading and game lifecycle
- `src/data/games.ts`: loading, search, and random selection
- `src/engine/ComparisonEngine.ts`: game comparison orchestration
- `src/engine/FieldComparator.ts`: numeric and date comparisons
- `src/config/comparison.ts`: difficulty thresholds
- `src/components/`: search and feedback UI
- `src/i18n.ts`: Chinese and English translations

The win condition uses Steam `appId`, not game name, so duplicate names cannot produce false wins.

## Data pipeline status

The scripts under `scripts/`, processed files under `data/`, and the `Makefile` are earlier experiments and may not currently form a working end-to-end pipeline. Do not rely on `make pipeline` until the Steam data source and schema are redesigned.

The frontend intentionally continues to use the existing 903-game catalog for now.

## Security

Never commit API tokens, cookies, or credentials. The root `token` path is ignored and should remain untracked. Any real credential that was committed previously should be revoked and rotated, because removing it from the current revision does not invalidate historical exposure.

## Deferred product work

The current baseline deliberately does not add daily challenges, accounts, leaderboards, multiplayer, statistics, a backend database, or a new data ingestion system. Those decisions should follow a product-direction review rather than further expanding the MVP by default.
