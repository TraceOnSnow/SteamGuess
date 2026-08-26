#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"

runtime_db=${STEAMGUESS_DB_PATH:-data/runtime/steamguess.sqlite}
catalog_db=${STEAMGUESS_CATALOG_DB_PATH:-data/catalog/catalog.sqlite}
min_samples=${STEAMGUESS_FEEDBACK_MIN_SAMPLES:-10}
prior_weight=${STEAMGUESS_FEEDBACK_PRIOR_WEIGHT:-20}
max_delta=${STEAMGUESS_FEEDBACK_MAX_DELTA:-3}
max_stddev=${STEAMGUESS_FEEDBACK_MAX_STDDEV:-20}

python3 -m scripts.catalog.update_difficulty_from_feedback \
  --runtime-db "$runtime_db" \
  --catalog-db "$catalog_db" \
  --min-samples "$min_samples" \
  --prior-weight "$prior_weight" \
  --max-delta "$max_delta" \
  --max-stddev "$max_stddev" \
  --apply \
  "$@"
