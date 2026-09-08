# Super League domain infrastructure

This directory is the wiring-ready platform layer for the Super League domain.

## Subdomains

- `api.superleague.site` — versioned public API scaffold.
- `status.superleague.site` — service status page.
- `docs.superleague.site` — documentation portal.
- `apply.superleague.site` — application portal UI.
- `admin.superleague.site` — restricted admin UI; disabled by default.
- `logs.superleague.site` — restricted audit UI; disabled by default.
- `cdn.superleague.site` — static asset origin; use `public/assets/`.
- `go.superleague.site` — reserved for short links/redirects.

## Current state

The UI and route contracts are intentionally prepared without pretending that the bot database, authentication, monitoring probes, or application submission backend are already connected.

Private admin/log interfaces return `503` unless `SL_PRIVATE_UI_ENABLED=true`. **Do not enable that variable on a public listener until authentication is implemented.**

## Environment

```text
PORT=3100
SL_WEBSITE_URL=https://superleague.site
SL_VERIFY_HEALTH_URL=https://verify.superleague.site/health
SL_MC_HEALTH_URL=
SL_API_HEALTH_URL=
SL_DISCORD_HEALTH_URL=
SL_PRIVATE_UI_ENABLED=false
```

## Data adapter

The API currently reads optional JSON files from `data/` for `teams`, `players`, `matches`, and `standings`. Replace that adapter with the existing Super League database after deployment. Do not expose `users.json` itself.

## Recommended wiring

Reverse proxy each subdomain to this service on localhost. Keep TLS at the reverse proxy. Put Cloudflare Access/authentication in front of `admin` and `logs`. Run the platform under PM2/systemd with a dedicated unprivileged account. Restrict the platform port to localhost/firewall rules.

## Future integrations

1. Connect `api/v1/*` to the bot database through a read-only adapter.
2. Add authenticated Discord/Roblox identity to `apply`.
3. Add Cloudflare Access or equivalent to `admin` and `logs`.
4. Add real HTTP/TCP health probes to `status`.
5. Add signed webhook/event ingestion for bot security events.
6. Add immutable/versioned asset paths under `cdn`.
7. Add a controlled redirect map for `go` links.
