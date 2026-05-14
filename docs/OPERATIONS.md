# Midas Operations Runbook

## Infrastructure

| Component | Host | Address | Notes |
|---|---|---|---|
| Proxmox host | pve | 192.168.1.190 | `ssh root@192.168.1.190` |
| App CT 3120 | midas-app-prod | 192.168.1.210 | Docker host for api + web |
| DB CT 3220 | midas-db-prod | 192.168.1.211 | PostgreSQL 15 |
| Authentik CT 111 | authentik | 192.168.1.164 (DHCP) | Future SSO — not yet wired |

All operations go through the Proxmox host via `pct exec`.

---

## Accessing containers

```bash
# SSH to Proxmox host
ssh root@192.168.1.190

# Shell in app CT
pct exec 3120 -- bash

# Shell in DB CT
pct exec 3220 -- bash

# Shell directly in the API Docker container
pct exec 3120 -- docker exec -it midas-api-1 sh
```

---

## Service status

```bash
# From Proxmox host
pct exec 3120 -- docker compose -f /opt/midas/docker-compose.yml ps

# Verify version + environment
pct exec 3120 -- curl -s http://localhost:4000/api/v1/meta

# Check healthcheck detail
pct exec 3120 -- docker inspect midas-api-1 | python3 -c "import sys,json; h=json.load(sys.stdin)[0]['State']['Health']; print(h['Status']); [print(l['Output']) for l in h['Log'][-3:]]"
```

---

## Viewing logs

```bash
# API logs (follow)
pct exec 3120 -- docker compose -f /opt/midas/docker-compose.yml logs -f api

# Web (nginx) logs
pct exec 3120 -- docker compose -f /opt/midas/docker-compose.yml logs -f web

# Last N lines
pct exec 3120 -- docker logs --tail 100 midas-api-1
```

---

## Restarting services

**Important restart order:** Always restart the web container *after* the API container is
healthy. The Vite dev proxy resolves the `api` hostname at connection time; if the API is
still starting up when the web container first connects, the proxy will log
`ECONNREFUSED` for that attempt. Restarting web after API is up clears this.

```bash
# Full clean restart (preferred — waits for API, then restarts web)
pct exec 3120 -- bash -c '
  cd /opt/midas
  docker compose restart api
  sleep 8
  curl -sf http://localhost:4000/api/v1/health && docker compose restart web
'

# Restart API only (env var changes, schema changes)
pct exec 3120 -- docker compose -f /opt/midas/docker-compose.yml restart api

# Restart web only (client-side changes already HMR'd but proxy cache stale)
pct exec 3120 -- docker compose -f /opt/midas/docker-compose.yml restart web
```

---

## Deploying a new version

The API and web run in **dev mode** (`target: dev`) with source directories volume-mounted:
- `./apps/api/src` → `/app/apps/api/src` (tsx watch — auto-reloads on file change)
- `./packages` → `/app/packages` (shared types)
- `./apps/web/src` → `/app/apps/web/src` (Vite dev server — auto-reloads on file change)

**Database:** The production compose (`docker-compose.yml`) has no `db` service — the API reads `DATABASE_URL` from `.env` which points to CT 3220 (192.168.1.211). The `docker-compose.local.yml` override adds a local Postgres container for laptop dev.

### Source-only changes (no rebuild required)

Push the changed file(s) and tsx/Vite will reload automatically within ~2 seconds:

```bash
# Copy to Proxmox host
scp apps/api/src/routes/accountant.ts root@192.168.1.190:/tmp/accountant.ts

# Push into CT
ssh root@192.168.1.190 "pct push 3120 /tmp/accountant.ts /opt/midas/apps/api/src/routes/accountant.ts"

# Verify API reloaded (tsx watch logs restart)
ssh root@192.168.1.190 "pct exec 3120 -- docker logs --tail 5 midas-api-1"
# Look for: "[tsx] change in ./src/... Restarting..."
```

New source files added to `apps/api/src/lib/` or `apps/web/src/` also hot-reload — no Docker rebuild needed.

### Changes requiring rebuild (Dockerfile, package.json, node_modules)

```bash
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose build --no-cache api && docker compose up -d api'"
```

### Schema changes

Only needed if `apps/api/src/db/schema.ts` changed. The API container runs `db:push --force` on startup automatically, so a container restart is sufficient:

```bash
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose restart api'"
```

---

## Schema migrations

```bash
# Apply schema changes (dev: push directly)
pct exec 3120 -- docker compose -f /opt/midas/docker-compose.yml run --rm migrator

# The migrator runs: db:push --force && db:seed
# db:seed is idempotent — only inserts missing categories/users
```

---

## Credential rotation

```bash
# Run credential rotation script (generates new passwords, updates DB, stores in /root/midas-credentials.json on CT 3120)
pct exec 3120 -- bash /opt/midas/scripts/rotate-credentials.sh

# Retrieve credentials (read once and store in password manager)
pct exec 3120 -- cat /root/midas-credentials.json
```

---

## Backup operations

See `docs/BACKUP_RESTORE.md` for full details.

```bash
# Manual backup run
pct exec 3120 -- bash /opt/midas/scripts/backup-midas.sh

# List backups
pct exec 3120 -- ls -lh /opt/midas/backups/

# View backup log
pct exec 3120 -- tail -50 /opt/midas/backups/backup.log
```

---

## Database operations

```bash
# Connect to DB as midas user
pct exec 3220 -- psql -U midas midas

# Table row counts
pct exec 3220 -- psql -U midas midas -c "
  SELECT schemaname, tablename, n_live_tup
  FROM pg_stat_user_tables ORDER BY n_live_tup DESC;"

# Check active connections
pct exec 3220 -- psql -U midas midas -c "SELECT count(*) FROM pg_stat_activity WHERE datname='midas';"

# DB size
pct exec 3220 -- psql -U midas midas -c "SELECT pg_size_pretty(pg_database_size('midas'));"
```

---

## Unit tests (local dev only — no DB required)

```bash
# From repo root
npm run test --workspace=apps/api

# Watch mode
npm run test:watch --workspace=apps/api
```

Tests live in `apps/api/src/__tests__/`. Currently covers:
- `flags.test.ts` — 37 tests for `computeFlags()` (queue flag derivation)
- `reviewSchema.test.ts` — 13 tests for review action parsing/validation

---

## Workflow verification

Covers request-info, resolve-request bugfix, payment methods, queue flags, Zoho readiness:

```bash
pct exec 3120 -- bash /opt/midas/scripts/verify-workflows.sh
```

Expected output: all checks green. Runs in ~5 seconds. Cleans up after itself.

---

## Smoke test

Run from inside CT 3120 (uses localhost, avoids Docker container IP instability):
```bash
# From Proxmox host — replace <admin_password> with the actual value from /opt/midas/.env
ssh root@192.168.1.190 "pct exec 3120 -- bash -c '
  API_URL=http://localhost:4000 WEB_URL=http://localhost:5173 \
    ADMIN_EMAIL=admin@midas.local ADMIN_PASS=<admin_password> \
    bash /opt/midas/scripts/smoke-test.sh
'"
```

Or from a dev machine with the password available:
```bash
API_URL=http://192.168.1.210:4000 \
WEB_URL=http://192.168.1.210:5173 \
ADMIN_EMAIL=admin@midas.local \
ADMIN_PASS=<password> \
bash scripts/smoke-test.sh
```

> Note: Do NOT use Docker-internal container IPs (172.18.x.x) for smoke tests — these change after each container recreation.

## Upload validation tests

```bash
# Replace <admin_password> with the actual value from /opt/midas/.env
pct exec 3120 -- bash -c '
  API_URL=http://localhost:4000 ADMIN_EMAIL=admin@midas.local ADMIN_PASS=<admin_password> \
    bash /opt/midas/scripts/test-upload-validation.sh
'
```

---

## Environment file

Location: `/opt/midas/.env` on CT 3120.

After editing `.env`, restart the API:
```bash
pct exec 3120 -- docker compose -f /opt/midas/docker-compose.yml restart api
```

---

## CT startup order

Managed by Proxmox startup/shutdown order. If manually starting:
1. Start CT 3220 first (DB) — `pct start 3220`
2. Wait ~10 seconds for PostgreSQL to be ready
3. Start CT 3120 (app) — `pct start 3120`

Docker containers start automatically on CT boot (`restart: always`).

---

## Disk usage

```bash
pct exec 3120 -- df -h
pct exec 3120 -- du -sh /opt/midas/uploads/
pct exec 3120 -- du -sh /opt/midas/backups/
```

---

## Common issues

### Container shows "unhealthy"

Check actual endpoint:
```bash
pct exec 3120 -- curl -s http://localhost:4000/api/v1/health
pct exec 3120 -- wget -qO- http://localhost:80/ | head -5
```

If endpoints work but healthcheck fails, check Docker healthcheck logs:
```bash
pct exec 3120 -- docker inspect midas-api-1 --format '{{json .State.Health}}' | python3 -m json.tool
```

### Login shows "Invalid email or password" after many failed attempts

The login endpoint is rate-limited. If the in-memory rate limit is exhausted, valid
credentials are also rejected until the window expires.

- **Default limit:** 20 attempts per IP per 15-minute window (production-safe)
- **Dev/LAN setting:** set `AUTH_RATE_LIMIT_MAX=200` in `/opt/midas/.env`
- **Clear immediately:** restart the API container (in-memory limit resets on startup)

```bash
pct exec 3120 -- bash -c 'cd /opt/midas && docker compose restart api && sleep 8 && docker compose restart web'
```

All browser login attempts share the same source IP (the Vite proxy container), so one
operator hitting 20 failed attempts locks out the browser for the full window.

### API won't start (DB connection error)

Verify DB CT is running and accepting connections:
```bash
pct exec 3120 -- docker exec midas-api-1 sh -c 'pg_isready -h 192.168.1.211 -U midas'
```

### Migration fails interactively

The migrator uses `--force` to skip the interactive prompt. If it still fails:
```bash
pct exec 3120 -- docker compose -f /opt/midas/docker-compose.yml run --rm migrator
# Check output for specific SQL error
```

---

## UI Design Rules

**No emoji in Midas UI.** Use text labels and Lucide icon components instead.

- Emoji characters are not allowed anywhere in rendered UI: buttons, badges, headers, footers, empty states, system messages, or status text.
- Lucide SVG icons (`import { CheckCircle2 } from 'lucide-react'`) are allowed.
- Shell scripts may use ✓/✗ in terminal output (`printf`) — these are not browser-rendered and are exempt.
- This rule applies to all surfaces: web app, browser extension popup, admin pages, accountant pages, user pages.

**Footer text:** "Built by your haute tech team" (no heart symbol or decorative unicode).
