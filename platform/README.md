# Super League domain platform

The platform service fronts `api`, `status`, `docs`, `apply`, `admin`, `logs`, `cdn`, and `go` through one Node/Express process.

## What is wired

- **API:** reads the bot `users.json` through `SL_DB_PATH`; team names and live rosters come from Discord when `DISCORD_BOT_TOKEN` + `SL_DISCORD_GUILD_ID` are configured.
- **Roblox/Discord lookup:** uses the bot database and Discord REST data.
- **Applications:** public form with rate limiting, honeypot protection, bounded fields, local durable storage, audit entry, and optional Discord webhook delivery.
- **Status:** live HTTP probes plus optional Discord bot authentication check.
- **Admin:** disabled until `SL_PRIVATE_UI_ENABLED=true` and credentials are configured; protected by HTTP Basic Authentication.
- **Logs:** authenticated audit viewer and signed-secret event ingestion endpoint.
- **CDN:** static asset origin under `public/assets/`.
- **Go:** HTTPS-only redirect targets from `SL_REDIRECTS_JSON`.
- **Matches/standings:** configured JSON sources via `SL_MATCHES_FILE` and `SL_STANDINGS_FILE`; the bot currently has no native match-results database to read.

## Oracle wiring

The intended deployment remains `/home/opc/sl-platform/platform` with PM2 on port `3100` and Nginx terminating TLS. Keep the Node port private to the VM.

Copy `.env.example` to the platform environment and set at minimum:

```text
SL_DB_PATH=/home/opc/sl-bot/bot/users.json
SL_DISCORD_GUILD_ID=<server id>
DISCORD_BOT_TOKEN=<bot token>
SL_APPLICATION_WEBHOOK_URL=<optional discord webhook>
SL_AUDIT_INGEST_SECRET=<random 32+ byte secret>
```

Only enable the private UI after setting `SL_ADMIN_USERNAME` and `SL_ADMIN_PASSWORD`. Use a long random password and do not commit the environment file.

## Audit ingestion

`POST /api/v1/audit` requires `X-SL-Audit-Secret` and writes JSONL with restrictive file permissions. The bot security layer can send anti-nuke, anti-raid, moderation, and administrative events here without exposing the audit log publicly.

## Health checks

- `GET /health`
- `GET /api/v1/health`
- `GET /status.json`

## Important

The public API intentionally does **not** expose the raw database. It returns normalized team/player/identity records only. Discord data is cached briefly to avoid hammering the Discord API.
