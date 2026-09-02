#!/usr/bin/env bash
# Watch the current staged catalog job, resume it after transient failure,
# then verify the canonical converged database.
set -Eeuo pipefail
cd "$(dirname "$0")/../.."

work=${STEAMGUESS_CATALOG_WORK_DIR:-data/catalog/.weekly-work}/current
lock=${STEAMGUESS_CATALOG_LOCK:-data/catalog/.weekly-update.lock}
log=${STEAMGUESS_OVERNIGHT_LOG:-data/logs/catalog-overnight-$(date -u +%Y%m%dT%H%M%SZ).log}
mkdir -p "$(dirname "$log")"
exec >>"$log" 2>&1

echo "[$(date -Is)] overnight watcher started"
# Wait for the currently running weekly publisher to release its lock.
while ! flock -n "$lock" -c true 2>/dev/null; do
  sleep 60
done

attempt=0
while [[ -d "$work" && $attempt -lt ${STEAMGUESS_OVERNIGHT_MAX_RESUMES:-5} ]]; do
  attempt=$((attempt + 1))
  echo "[$(date -Is)] staged work remains; resume attempt $attempt"
  if STEAMGUESS_ACTIVE_LIMIT=4000 \
     STEAMGUESS_WEEKLY_FROM_EXISTING=1 \
     STEAMGUESS_STOREFRONT_DELAY=5 \
     STEAMGUESS_REVIEWS_DELAY=2 \
     STEAMGUESS_REVIEWS_RETRIES=4 \
     STEAMGUESS_REVIEWS_RETRY_DELAY=60 \
     ./scripts/ops/run_weekly_catalog.sh; then
    break
  fi
  echo "[$(date -Is)] resume failed; sleeping 5 minutes"
  sleep 300
done

if [[ -d "$work" ]]; then
  echo "[$(date -Is)] ERROR staged update still incomplete after $attempt resumes"
  exit 1
fi

python3 -m scripts.catalog.status --db data/catalog/catalog.sqlite
python3 scripts/ops/validate_catalog_release.py \
  --catalog data/catalog/steamspy_candidates.json \
  --playable public/games_demo.json \
  --db data/catalog/catalog.sqlite \
  --active-limit 4000

echo "[$(date -Is)] overnight catalog completion verified"
