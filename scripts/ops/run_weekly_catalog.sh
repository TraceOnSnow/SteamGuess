#!/usr/bin/env bash
# Build and publish one weekly catalog snapshot transactionally.
set -Eeuo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"

catalog=${STEAMGUESS_CATALOG_PATH:-data/catalog/steamspy_candidates.json}
db=${STEAMGUESS_CATALOG_DB_PATH:-data/catalog/catalog.sqlite}
playable=${STEAMGUESS_PLAYABLE_PATH:-public/games_demo.json}
state=${STEAMGUESS_STOREFRONT_STATE:-data/processed/storefront_localized_names_schinese.json}
raw_dir=${STEAMGUESS_STEAMSPY_RAW_DIR:-data/raw/steamspy}
work_root=${STEAMGUESS_CATALOG_WORK_DIR:-data/catalog/.weekly-work}
pics=${STEAMGUESS_PICS_FILE:-}
active_limit=${STEAMGUESS_ACTIVE_LIMIT:-1000}
detail_limit=${STEAMGUESS_DETAIL_LIMIT:-4000}
interval=${STEAMGUESS_STEAMSPY_INTERVAL:-120}
steamspy_retries=${STEAMGUESS_STEAMSPY_RETRIES:-2}
steamspy_retry_delay=${STEAMGUESS_STEAMSPY_RETRY_DELAY:-30}
storefront_delay=${STEAMGUESS_STOREFRONT_DELAY:-5}
reviews_delay=${STEAMGUESS_REVIEWS_DELAY:-5}
reviews_retries=${STEAMGUESS_REVIEWS_RETRIES:-3}
reviews_retry_delay=${STEAMGUESS_REVIEWS_RETRY_DELAY:-30}
log_dir=${STEAMGUESS_CATALOG_LOG_DIR:-data/logs}
backup_dir=${STEAMGUESS_CATALOG_BACKUP_DIR:-data/backups/catalog}
lock_path=${STEAMGUESS_CATALOG_LOCK:-data/catalog/.weekly-update.lock}

mkdir -p "$log_dir" "$(dirname "$lock_path")" "$backup_dir"
log_file="$log_dir/catalog-weekly-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$log_file") 2>&1

exec 9>"$lock_path"
if ! flock -n 9; then
  echo "Another weekly catalog update is already running; exiting safely."
  exit 75
fi

work="$work_root/current"
resuming=0
if [[ -d "$work" ]]; then
  resuming=1
  echo "Resuming staged weekly update from $work"
else
  mkdir -p "$work"
fi
success=0
cleanup() {
  if [[ "$success" == 1 ]]; then
    rm -rf "$work"
  else
    echo "Staged weekly update preserved at $work; rerun to resume."
  fi
}
trap cleanup EXIT

notify_failure() {
  local code=$?
  if [[ -n ${STEAMGUESS_ALERT_WEBHOOK:-} ]] && command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --max-time 10 \
      -H 'Content-Type: application/json' \
      --data "$(python3 -c 'import json,sys; print(json.dumps({"text": "SteamGuess weekly catalog failed", "exitCode": int(sys.argv[1]), "log": sys.argv[2]}))' "$code" "$log_file")" \
      "$STEAMGUESS_ALERT_WEBHOOK" || echo "WARN failure notification could not be delivered"
  fi
  exit "$code"
}
trap notify_failure ERR

copy_or_init() {
  local source=$1 destination=$2
  mkdir -p "$(dirname "$destination")"
  if [[ ! -e "$destination" && -e "$source" ]]; then
    cp -a "$source" "$destination"
  fi
}

# Discover writes a new catalog but preserves enrichment only from the file at
# --out, so seed the staged catalog with the last successful snapshot.
copy_or_init "$catalog" "$work/catalog.json"
copy_or_init "$db" "$work/catalog.sqlite"
copy_or_init "$playable" "$work/games_demo.json"
copy_or_init "$state" "$work/storefront-state.json"
mkdir -p "$work/raw-steamspy"

args=(
  --catalog "$work/catalog.json"
  --db "$work/catalog.sqlite"
  --playable "$work/games_demo.json"
  --storefront-state "$work/storefront-state.json"
  --raw-dir "$work/raw-steamspy"
  --active-limit "$active_limit"
  --detail-limit "$detail_limit"
  --interval "$interval"
  --steamspy-retries "$steamspy_retries"
  --steamspy-retry-delay "$steamspy_retry_delay"
  --storefront-delay "$storefront_delay"
  --reviews-delay "$reviews_delay" \
  --reviews-retries "$reviews_retries" \
  --reviews-retry-delay "$reviews_retry_delay"
)
[[ -n "$pics" ]] && args+=(--pics "$pics")
[[ ${STEAMGUESS_AUTO_PICS:-1} == 1 ]] && args+=(--auto-pics)
args+=(--pics-chunk-size "${STEAMGUESS_PICS_CHUNK_SIZE:-500}")
args+=(--pics-timeout "${STEAMGUESS_PICS_TIMEOUT:-600}")
[[ ${STEAMGUESS_WEEKLY_FROM_EXISTING:-0} == 1 ]] && args+=(--from-existing-catalog)
[[ ${STEAMGUESS_WEEKLY_SKIP_ENRICHMENT:-0} == 1 ]] && args+=(--skip-enrichment)
[[ "$resuming" == 1 ]] && args+=(--resume-discovery)

python3 -m scripts.catalog.update_weekly "${args[@]}"
if [[ ${STEAMGUESS_TEST_FAIL_AFTER_UPDATE:-0} == 1 ]]; then
  echo "TEST failure injection after update_weekly; staged workspace must be preserved"
  exit 97
fi
python3 scripts/ops/validate_catalog_release.py \
  --catalog "$work/catalog.json" \
  --playable "$work/games_demo.json" \
  --db "$work/catalog.sqlite" \
  --active-limit "$active_limit"

# Keep the previous canonical snapshot before the atomic replacement.
stamp=$(date -u +%Y%m%dT%H%M%SZ)
if [[ -f "$db" ]]; then cp -a "$db" "$backup_dir/catalog-$stamp.sqlite"; fi
if [[ -f "$catalog" ]]; then cp -a "$catalog" "$backup_dir/catalog-$stamp.json"; fi

mkdir -p "$(dirname "$catalog")" "$(dirname "$db")" "$(dirname "$playable")" "$(dirname "$state")"
mv -f "$work/catalog.json" "$catalog"
mv -f "$work/catalog.sqlite" "$db"
mv -f "$work/games_demo.json" "$playable"
if [[ -f "$work/storefront-state.json" ]]; then
  mv -f "$work/storefront-state.json" "$state"
fi
success=1

# Keep a bounded number of old catalog snapshots.
find "$backup_dir" -type f \( -name 'catalog-*.sqlite' -o -name 'catalog-*.json' \) -printf '%T@ %p\n' \
  | sort -nr | awk 'NR > 28 {sub(/^[^ ]+ /, ""); print}' | xargs -r rm -f

printf 'WEEKLY CATALOG READY catalog=%s db=%s log=%s\n' "$catalog" "$db" "$log_file"
trap - ERR
