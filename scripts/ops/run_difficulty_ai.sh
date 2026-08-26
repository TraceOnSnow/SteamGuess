#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

exec python3 -m scripts.catalog.score_difficulty_ai_codex \
  --model "${STEAMGUESS_DIFFICULTY_AI_MODEL:-deepseek-v4-flash}" \
  --reasoning-effort "${STEAMGUESS_DIFFICULTY_AI_REASONING:-medium}" \
  --batch-size "${STEAMGUESS_DIFFICULTY_AI_BATCH_SIZE:-20}" \
  --delay "${STEAMGUESS_DIFFICULTY_AI_DELAY:-1}" \
  --timeout "${STEAMGUESS_DIFFICULTY_AI_TIMEOUT:-900}" \
  --retries "${STEAMGUESS_DIFFICULTY_AI_RETRIES:-2}" \
  --retry-delay "${STEAMGUESS_DIFFICULTY_AI_RETRY_DELAY:-15}" \
  --resume \
  "$@"
