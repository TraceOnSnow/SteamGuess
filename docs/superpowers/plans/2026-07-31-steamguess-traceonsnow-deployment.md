# SteamGuess traceonsnow deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish SteamGuess at `https://steamguess.traceonsnow.com` through the server's existing Caddy proxy without publicly exposing its application port.

**Architecture:** Docker Compose runs the Node service on loopback port 4173 and retains the named SQLite data volume. Caddy owns TLS and proxies the hostname to that loopback upstream. A global Codex skill captures this exact inspect–validate–release–rollback workflow for later services.

**Tech Stack:** Docker Compose, Node.js 24, Caddy, systemd, SQLite, Bash.

## Global Constraints

- Use `127.0.0.1:4173:4173`, never a public binding for SteamGuess.
- Set `STEAMGUESS_TRUST_PROXY=true` only with Caddy as the local reverse proxy.
- Preserve the `steamguess-data` Docker volume; never use `docker compose down -v`.
- Validate Caddy before reload, and verify both local and public `/api/health` afterward.
- Do not reveal or commit values from `.env`.

---

### Task 1: Create the reusable deployment skill

**Files:**
- Create: `/home/trace/.codex/skills/deploy-traceonsnow/SKILL.md`
- Create: `/home/trace/.codex/skills/deploy-traceonsnow/agents/openai.yaml`
- Create: `/home/trace/.codex/skills/deploy-traceonsnow/scripts/verify-release.sh`

**Interfaces:**
- Consumes: a repository path, hostname, and loopback upstream.
- Produces: a safe release procedure and `verify-release.sh <hostname> <port>` health verifier.

- [ ] **Step 1: Create a failing verification case**

Run:

```bash
/home/trace/.codex/skills/deploy-traceonsnow/scripts/verify-release.sh invalid.example 4173
```

Expected: non-zero exit because the localhost health endpoint is unavailable.

- [ ] **Step 2: Write the skill and verification script**

The skill must require inspection, Caddyfile backup, `caddy validate`, reload,
Compose start, local/public health checks, and a rollback that restores the
Caddyfile without deleting data. The script must fail unless both
`http://127.0.0.1:$2/api/health` and `https://$1/api/health` return JSON with
`"ok":true`.

- [ ] **Step 3: Validate the skill**

Run:

```bash
python3 /home/trace/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  /home/trace/.codex/skills/deploy-traceonsnow
```

Expected: validation succeeds.

### Task 2: Restrict the application upstream and prepare release checks

**Files:**
- Modify: `compose.yaml:12-13`
- Modify: `compose.yaml:20`

**Interfaces:**
- Consumes: Caddy's loopback upstream contract.
- Produces: a Compose service reachable only at `127.0.0.1:4173` and trusted proxy support.

- [ ] **Step 1: Write the expected Compose assertions**

Run:

```bash
docker compose config | grep -F '127.0.0.1:4173:4173'
docker compose config | grep -F 'STEAMGUESS_TRUST_PROXY: "true"'
```

Expected before the edit: the first command fails because the port is currently public.

- [ ] **Step 2: Change the Compose contract**

Set the ports entry to `127.0.0.1:4173:4173` and set
`STEAMGUESS_TRUST_PROXY: "true"`.

- [ ] **Step 3: Verify the rendered configuration and application quality gate**

Run:

```bash
docker compose config
npm run release:check
```

Expected: Compose renders the loopback binding and the full project quality gate exits 0.

### Task 3: Publish the Caddy site and verify the live release

**Files:**
- Modify: `/etc/caddy/Caddyfile`
- Create: `/etc/caddy/Caddyfile.steamguess-YYYYMMDD-HHMMSS.bak`

**Interfaces:**
- Consumes: `steamguess.traceonsnow.com` DNS A record and local upstream `127.0.0.1:4173`.
- Produces: public HTTPS reverse proxy and a healthy `steamguess` container.

- [ ] **Step 1: Back up and validate the candidate Caddyfile**

Create a timestamped backup, append exactly:

```caddyfile
steamguess.traceonsnow.com {
    reverse_proxy 127.0.0.1:4173
}
```

Run:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
```

Expected: `Valid configuration`.

- [ ] **Step 2: Start the service and reload Caddy**

Run:

```bash
docker compose up -d --build
sudo systemctl reload caddy
docker compose ps
```

Expected: `steamguess` is running and its port is `127.0.0.1:4173->4173/tcp`.

- [ ] **Step 3: Verify local and public health**

Run:

```bash
/home/trace/.codex/skills/deploy-traceonsnow/scripts/verify-release.sh \
  steamguess.traceonsnow.com 4173
```

Expected: both endpoints return `{"ok":true}` and the script exits 0.

- [ ] **Step 4: Roll back if verification fails**

Restore the timestamped Caddyfile backup, run `sudo caddy validate --config
/etc/caddy/Caddyfile`, then `sudo systemctl reload caddy`. Inspect
`docker compose logs --tail=200 steamguess`; do not delete the volume.
