#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
repo=TraceOnSnow/SteamGuess
host=43.155.230.220
key_path="$HOME/.ssh/steamguess_github_deploy"
authorized_keys="$HOME/.ssh/authorized_keys"
deploy_command="$root/scripts/ops/deploy_production.sh"

gh auth status >/dev/null
test -r /etc/ssh/ssh_host_ed25519_key.pub

install -d -m 700 "$HOME/.ssh"
if [[ ! -f $key_path ]]; then
  ssh-keygen -q -t ed25519 -N '' -f "$key_path" -C steamguess-github-actions
fi

key_options="restrict,command=\"$deploy_command\""
authorized_line="${key_options} $(<"${key_path}.pub")"
touch "$authorized_keys"
chmod 600 "$authorized_keys"
grep -qxF "$authorized_line" "$authorized_keys" || printf '%s\n' "$authorized_line" >> "$authorized_keys"

host_key="${host} $(</etc/ssh/ssh_host_ed25519_key.pub)"
gh api --method PUT "repos/${repo}/environments/production" >/dev/null
gh secret set --repo "$repo" --env production DEPLOY_SSH_KEY < "$key_path"
printf '%s\n' "$host_key" | gh secret set --repo "$repo" --env production DEPLOY_HOST_KEY
gh variable set --repo "$repo" --env production DEPLOY_HOST --body "$host"

printf 'GitHub production deployment bootstrap complete for %s.\n' "$repo"
