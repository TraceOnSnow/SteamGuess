#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
command=${SSH_ORIGINAL_COMMAND:-}

if [[ ! $command =~ ^deploy\ [0-9a-f]{40}$ ]]; then
  printf 'Only "deploy <40-character lowercase commit SHA>" is allowed.\n' >&2
  exit 64
fi

sha=${command#deploy }
git -C "$root" fetch --quiet origin main
git -C "$root" cat-file -e "${sha}^{commit}"
git -C "$root" merge-base --is-ancestor "$sha" origin/main
git -C "$root" checkout --detach --quiet "$sha"

IMAGE_TAG=$sha docker compose -f "$root/compose.production.yaml" pull
IMAGE_TAG=$sha docker compose -f "$root/compose.production.yaml" up -d --remove-orphans

wait_for_health() {
  local endpoint=$1
  local body
  for _ in {1..30}; do
    if body=$(curl --fail --silent --show-error --max-time 5 "$endpoint" 2>/dev/null) \
      && [[ $body == *'"ok":true'* ]]; then
      return 0
    fi
    sleep 1
  done
  printf 'Health check did not become ready: %s\n' "$endpoint" >&2
  return 1
}

wait_for_health http://127.0.0.1:4173/api/health
wait_for_health https://steamguess.traceonsnow.com/api/health
printf 'Deployed %s\n' "$sha"
