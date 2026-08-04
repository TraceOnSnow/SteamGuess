# SteamGuess traceonsnow.com deployment design

## Goal

Deploy SteamGuess at `https://steamguess.traceonsnow.com` using the server's
existing Caddy and Docker Compose conventions. Preserve runtime data across
rebuilds and restrict the application upstream to the local host.

## Architecture

`Caddy` terminates TLS for `steamguess.traceonsnow.com` and reverse-proxies to
`127.0.0.1:4173`. The `steamguess` Compose service binds only that loopback
port, retains its named `steamguess-data` volume, and trusts forwarded client
addresses only from the local Caddy proxy.

The pre-existing A record resolves to the server, so Caddy's managed HTTPS can
obtain and renew the certificate without an application DNS change.

## Reusable skill

Install a global `deploy-traceonsnow` skill under `/home/trace/.codex/skills`.
It will codify: inspect the live Caddy and Compose state; bind an upstream to
loopback; back up and validate Caddy before reload; start or rebuild Compose;
verify local health and public HTTPS; and roll back by restoring the Caddyfile
and the previous Compose state. It will never expose an upstream publicly or
delete a Docker volume.

## Release sequence

1. Validate the project with `npm run release:check`.
2. Change the Compose port binding to `127.0.0.1:4173:4173` and set trusted
   proxy support for the Caddy-only path.
3. Back up `/etc/caddy/Caddyfile`, append the SteamGuess site block, run
   `caddy validate`, and reload Caddy only after validation succeeds.
4. Build and start the Compose service.
5. Verify container health, `http://127.0.0.1:4173/api/health`, and
   `https://steamguess.traceonsnow.com/api/health`.

## Failure handling

If Caddy validation or reload fails, restore its backup and reload the previous
configuration. If the app fails its local health check, leave Caddy serving no
new configuration to the failed upstream, inspect Compose logs, and preserve
the `steamguess-data` volume. No DNS, firewall, or unrelated services are
changed.
