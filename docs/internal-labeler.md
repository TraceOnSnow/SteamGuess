# Internal difficulty manager

The difficulty manager is an authenticated administration page backed directly
by `data/catalog/catalog.sqlite`. It does not use browser-local label files.

## Start and open

For local development, run `npm run dev` and open `/labeler`. The Vite
development API uses the canonical catalog database and permits local access
without an admin token.

For the production-style server:

```bash
VITE_LABELER_ENABLED=true npm run build
STEAMGUESS_ADMIN_TOKEN=change-me npm start
```

Open `/labeler` and enter the same token. It is stored in `sessionStorage` for
the current tab only.

## Difficulty authority

The effective score has one fixed precedence order:

```text
locked manual override > accepted player feedback > eligible AI candidate
```

Relevant tables:

```text
difficulty_ai_candidates       baseline score and game eligibility
difficulty_feedback_scores     accepted aggregate player adjustment
difficulty_feedback_history    append-only adjustment audit
difficulty_overrides           manual score and lock
catalog_exclusions             unsuitable / too_obscure editorial removal
```

AI candidates with `eligible = false` are software, tools, noisy apps, or other
unsuitable entries. They are absent from the manager, Search catalog, and
Playable answer pool. A row with no AI candidate may remain searchable but is
not an answer until it receives an authoritative difficulty. Manual
`catalog_exclusions` are separate and survive weekly updates.

## Page behavior

The page uses:

```text
GET /api/admin/difficulties
PUT /api/admin/difficulties/:appid
```

It supports search, Active/all scope, filters, score sorting, integer input,
sliders, locking, and editorial removal.

- **Unlocked manual score:** saved as an editor draft; it does not affect play.
- **Locked manual score:** immediately becomes the final effective score.
- **Reset:** clears the manual draft and returns to feedback or AI baseline.
- **Remove from Active:** records a durable editorial exclusion.
- **Restore candidate:** removes that editorial exclusion; the next catalog
  rebuild may select the game again.

Difficulty ranges:

```text
0–14    beginner
15–24   easy
25–49   normal
50–74   hard
75–100  hell
```

## Publishing and feedback

The weekly catalog runner publishes a Search snapshot. Rows with eligible AI
candidates receive effective difficulties after accepted feedback and locked
manual values are overlaid; those scored rows form the Playable answer pool.
AI reevaluation is intentionally a separate explicit operation; weekly Steam
metadata updates do not invoke an AI provider.

Player feedback is synchronized with:

```bash
./scripts/ops/update_difficulty_from_feedback.sh
```

After synchronization, run the normal publishing stage or the next weekly
update to refresh `public/games_demo.json`.

## Retired workflows

The browser-local label JSON, curated-pool importer, generated
`labeling_catalog.json`, and difficulty fitting workflow are retired and must
not be restored. Historical logs may retain old command names as immutable run
records.
