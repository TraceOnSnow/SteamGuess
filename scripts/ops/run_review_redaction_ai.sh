#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/../.."

catalog=${STEAMGUESS_CATALOG_PATH:-data/catalog/steamspy_candidates.json}
out=${STEAMGUESS_REDACTION_OUT:-data/analysis/review-redaction/review_redactions.jsonl}
model=${STEAMGUESS_REDACTION_MODEL:-}
scope=${STEAMGUESS_REDACTION_SCOPE:-detail}
active_limit=${STEAMGUESS_ACTIVE_LIMIT:-1000}
detail_limit=${STEAMGUESS_DETAIL_LIMIT:-4000}
reviews_per_language=${STEAMGUESS_REDACTION_REVIEWS_PER_LANGUAGE:-100}
import_db=${STEAMGUESS_REDACTION_IMPORT_DB:-}
mkdir -p "$(dirname "$out")" data/logs

args=(
  --catalog "$catalog"
  --out "$out"
  --scope "$scope"
  --active-limit "$active_limit"
  --detail-limit "$detail_limit"
  --reviews-per-language "$reviews_per_language"
  --delay "${STEAMGUESS_REDACTION_DELAY:-2}"
  --timeout "${STEAMGUESS_REDACTION_TIMEOUT:-120}"
  --retries "${STEAMGUESS_REDACTION_RETRIES:-3}"
  --retry-delay "${STEAMGUESS_REDACTION_RETRY_DELAY:-10}"
  --resume
  --allow-failures
)
if [[ -n "$model" ]]; then
  args+=(--model "$model")
fi
if [[ -n "${STEAMGUESS_REDACTION_API_BASE:-}" ]]; then
  args+=(--api-base "$STEAMGUESS_REDACTION_API_BASE")
fi
if [[ -n "${STEAMGUESS_REDACTION_API_KEY_ENV:-}" ]]; then
  args+=(--api-key-env "$STEAMGUESS_REDACTION_API_KEY_ENV")
fi
if [[ -n "${STEAMGUESS_REDACTION_APPIDS:-}" ]]; then
  args+=(--appids "$STEAMGUESS_REDACTION_APPIDS")
fi

python3 -m scripts.catalog.redact_reviews_ai "${args[@]}" "$@"

if [[ -n "$import_db" ]]; then
  import_args=(--input "$out" --db "$import_db")
  for argument in "$@"; do
    if [[ "$argument" == "--dry-run" ]]; then
      import_args+=(--dry-run)
      break
    fi
  done
  python3 -m scripts.catalog.import_review_redactions "${import_args[@]}"
fi
