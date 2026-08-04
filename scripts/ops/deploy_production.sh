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

local_health=$(curl --fail --silent --show-error --max-time 15 http://127.0.0.1:4173/api/health)
public_health=$(curl --fail --silent --show-error --max-time 15 https://steamguess.traceonsnow.com/api/health)
[[ $local_health == *'"ok":true'* && $public_health == *'"ok":true'* ]]
printf 'Deployed %s\n' "$sha"
