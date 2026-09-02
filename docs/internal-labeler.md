# Internal difficulty manager

The labeler is an authenticated editor for the `games` table. It does not use a
labeling JSON file or browser-local storage.

## Start

```bash
npm run dev
```

Open `/labeler`. In production, set `STEAMGUESS_ADMIN_TOKEN` and use the same
token in the page.

## What it edits

The page lists games by current score and supports search, sorting, integer or
slider editing, locking and pool status changes.

- **Manual score** writes `games.difficulty_manual_score` and updates the current
  `difficulty_score`.
- **Lock** writes `games.difficulty_locked`. A locked score is not changed by
  player-feedback synchronization.
- **软件 / 不适合** sets `pool_status = excluded`.
- **太冷门** sets `pool_status = search_only`.
- **恢复候选** returns the row to `eligible`.

The old AI score, regression score, labeling catalog and historical difficulty
side tables are not used.

## Difficulty ranges

```text
0–14 beginner    15–24 easy    25–49 normal
50–74 hard       75–100 hell
```

`heat_rank` is visible catalog metadata only. It is not used to decide whether
a game is allowed in the answer pool.

## Player feedback

Completed games can submit a score and tier. Raw submissions remain in
`data/runtime/steamguess.sqlite`. The batch synchronizer aggregates valid latest
feedback per player/game and writes the aggregate to the matching `games` row.

```bash
./scripts/ops/update_difficulty_from_feedback.sh
```

Unlocked games may receive a feedback-based update; locked games retain their
manual score while their feedback statistics can still be recorded.
