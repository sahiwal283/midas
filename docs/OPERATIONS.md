# Midas Operations Runbook

## Zoho Integration Service connectivity (v0.1.4-alpha)

Midas talks to Zoho **only** through the Zoho Integration Service (CT 9503, `http://192.168.1.205:8000`); it never calls Zoho directly. Auth is `Authorization: Bearer <ZOHO_SERVICE_TOKEN>` + `X-Brand` (token in `/opt/midas/.env`, never printed). Do not send the app token as `X-Internal-Token`.

Check connectivity (accountant/admin session required):
```bash
curl -s -b <cookiejar> https://midas.booute.duckdns.org/api/v1/zoho/service-health
# Expect: service.reachable=true, serviceVersion, zohoMode=mock, dryRun=true, liveWritesEnabled=false
```

**Current blocker for any real Zoho call:** the integration service is **not authorized against Zoho** for the `haute_brands` org — its Zoho data endpoints return `ZOHO_AUTH_INVALID`. This is owned by the integration-service team, not Midas. Midas remains in `ZOHO_MODE=mock` / `ZOHO_DRY_RUN=true` (no live writes). See `docs/ZOHO_INTEGRATION.md`.

## Infrastructure

| Component | Host | Address | Notes |
|---|---|---|---|
| Proxmox host | pve | 192.168.1.190 | `ssh root@192.168.1.190` |
| App CT 3120 | midas-app-prod | 192.168.1.210 | Docker host for api + web |
| DB CT 3220 | midas-db-prod | 192.168.1.211 | PostgreSQL 15 |
| Zoho Integration Service CT 9503 | zoho-svc | 192.168.1.205:8000 | Proxies to Zoho Books; holds OAuth; inactive while `ZOHO_MODE=mock` |
| OCR CT 9500 | ocr-service | 192.168.1.195:8000 | Live OCR engine (RapidOCR + Document AI fallback); used by Trade Show + Midas when `OCR_MODE=service` |
| Authentik CT | authentik | 192.168.1.164 | SSO provider; `AUTH_MODE=authentik` live |

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

# Recreate API only (required for env var changes — restart alone does not reload env_file)
pct exec 3120 -- bash -c 'cd /opt/midas && docker compose up -d api'

# Restart web only (client-side changes already HMR'd but proxy cache stale)
pct exec 3120 -- docker compose -f /opt/midas/docker-compose.yml restart web
```

---

## Deploying a new version

Both API and web run the **prod** target from `docker-compose.prod.yml`: the API serves
compiled `/app/dist` and web serves a static nginx build. **Neither hot-reloads.** Every
code change — including a one-line edit to a single file — needs a rebuild of the
affected container. (Until mid-August 2026 the API did run `target: dev` with tsx watch
and source bind-mounts; that is no longer true, and pushing a source file alone now
changes nothing.)

**Database:** The production compose (`docker-compose.yml`) has no `db` service — the API reads `DATABASE_URL` from `.env` which points to CT 3220 (192.168.1.211). The `docker-compose.local.yml` override adds a local Postgres container for laptop dev.

### Getting changed source onto the CT

`/opt/midas` is not a git checkout — ship a tarball of exactly what changed, then rebuild:

```bash
# Package only the files this release touches
COPYFILE_DISABLE=1 tar czf /tmp/midas-X.Y.Z.tar.gz $(git diff --name-only <prev-tag> HEAD | tr '\n' ' ')

scp /tmp/midas-X.Y.Z.tar.gz root@192.168.1.190:/tmp/
ssh root@192.168.1.190 "pct push 3120 /tmp/midas-X.Y.Z.tar.gz /tmp/midas-X.Y.Z.tar.gz \
  && pct exec 3120 -- bash -c 'cd /opt/midas && tar xzf /tmp/midas-X.Y.Z.tar.gz'"
```

Then rebuild the containers (below). A stale `dist` is the usual reason a deployed fix
appears to do nothing.

> **A file-push deploy never deletes.** `tar xzf` extracts over the existing tree, so a
> file removed in git still exists on CT 3120 and will break the build (observed
> 2026-08-12: a deleted `apps/web/src/api/partnerExpenses.ts` failed `tsc` in the web
> image). After any branch that deletes files, remove them explicitly:
>
> ```bash
> git diff --diff-filter=D --name-only <merge-base> HEAD   # list deletions
> ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && rm -f <paths>'"
> ```

### Changes requiring rebuild (Dockerfile, package.json, node_modules)

```bash
# API — prod file ONLY (target: prod, compiled /app/dist):
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose -f docker-compose.prod.yml up -d --no-deps --build api'"
```

> ⚠️ **Do not rebuild the API from the base compose.** `docker-compose.yml`'s `api`
> service is `target: dev` with `NODE_ENV: development`; building from it silently
> downgrades production to the dev target. Verify after every API deploy:
> `curl -s https://midas.booute.duckdns.org/api/v1/meta` → expect
> `"environment":"production"` and the version you just shipped. (Observed
> 2026-08-25: this section previously recommended the base file, which was accurate
> only while the prod image was broken.)

> ⚠️ **Rebuilding the WEB container — read this first.** The base `docker-compose.yml` `web` service is `target: dev` (Vite dev server, which **403-blocks the production host** `midas.booute.duckdns.org`). The production web is the **nginx** (`target: prod`) build defined in `docker-compose.prod.yml`. Rebuild web with the **prod file only** — do NOT use base-only (dev server) and do NOT merge `-f docker-compose.yml -f docker-compose.prod.yml` for web (the two files' `ports` lists merge to a duplicate `5173` mapping → "port already allocated"):
>
> ```bash
> ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose -f docker-compose.prod.yml up -d --no-deps --build web'"
> ```
>
> After any web rebuild, verify the domain serves nginx (not the Vite block page):
> `curl -s -o /dev/null -w '%{http_code}\n' https://midas.booute.duckdns.org/`  → expect **200**.

### Schema changes

Only needed if `apps/api/src/db/schema.ts` changed and a migration was generated
(`apps/api/drizzle/NNNN_*.sql`).

**A container restart does not apply it.** The prod target's `CMD` is
`["sh", "-c", "node dist/server.js"]` (`apps/api/Dockerfile:63`) — it starts the
compiled server and nothing else; there is no push, no migration. The
`db:migrate:sql && db:seed` startup sequence some of this doc's older wording
assumed belongs to the **dev** target only (`apps/api/Dockerfile:19`), which is
never what runs on CT 3120. In production, migrations are applied by exactly one
thing: the one-shot `migrator` service (`docker-compose.prod.yml`), whose command
runs `src/db/runSqlMigrations.ts` and then `src/db/seed.ts`.

> **Why it calls the scripts directly.** Until 2026-08-26 that command was
> `npm run db:migrate:sql && npm run db:seed`, and it had never once worked:
> both scripts pass `tsx --env-file=../../.env`, which is correct on a laptop
> but wrong in the container. `env_file:` injects the variables into the
> process; it does not create `/app/.env`. So the service died with
> `node: ../../.env: not found` before reaching the database, which is why
> earlier migrations were applied by hand with `psql`. Leave the npm scripts
> alone — local development needs the flag.

**The migrator image must be rebuilt every time.** The migrator builds
`target: build`, which bakes `apps/api/drizzle/` into its image at build time,
from whatever is on disk in `/opt/midas` at the moment it builds. `docker
compose run` builds a service image **only when none exists** — and CT 3120
already has a migrator image, left over from 0027–0029. A bare `run --rm
migrator` therefore re-runs an image built from an *older* `/opt/midas`: the
new `.sql` file is not in it, the runner finds nothing new, prints
`skip 0029 (already applied)` and `SQL migrations complete`, and exits **0**.
Success is reported and the schema is unchanged. Always pass `--build` (or run
`docker compose -f docker-compose.prod.yml build migrator` first):

```bash
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose -f docker-compose.prod.yml run --rm --build migrator'"
```

Confirm from the output that the new migration was actually applied — look for
`applying 00NN_...` / `applied 00NN_...`, not just the trailing
`SQL migrations complete`, which prints either way.

**Order: extract → migrate → rebuild api + web.**

An additive migration (new nullable column, new table, new index; nothing
renamed, dropped or made `NOT NULL`) leaves the *old* code working against the
migrated schema — the running API simply never selects the new column. So
migrate while the old API is still up, then swap in the new one. Done in this
order there is no window at all in which new code meets an old schema.

The reverse order — rebuild api first, then migrate — opens exactly that
window, and it is not a graceful one. Drizzle emits explicit column lists, so
a new API that expects a column the DB does not have fails every query touching
that table with `column "…" does not exist`. For 1.6.0 that would have meant
every receipt read and write, site-wide, from the moment the API came up.

1. Extract the release tarball (above).
2. Run the migrator with `--build` (above), and read its output.
3. Rebuild api, then web (above).

**A non-additive migration needs a different plan**, because neither order is
safe: a `DROP COLUMN`, a rename, a type change or a new `NOT NULL` breaks the
*old* code the moment it lands, so migrate-first breaks production before the
new API arrives, and rebuild-first breaks it before the migration does. Those
need an expand/contract split across two releases (release N adds the new shape
and writes both; release N+1 drops the old one), or an accepted maintenance
window with the API stopped. Decide which before shipping, not during.

Restarting the API container is neither necessary nor sufficient for a schema
change — it just restarts the already-compiled server against whatever schema
the DB currently has.

---

## Schema migrations

```bash
# Preferred (Phase 1+): idempotent SQL runner — baselines pre-0014 if expenses exist
# --build is NOT optional: without it, compose reuses the existing migrator image,
# which has the OLD drizzle/ baked in, and exits 0 having applied nothing.
pct exec 3120 -- docker compose -f /opt/midas/docker-compose.prod.yml run --rm --build migrator

# The migrator runs: db:migrate:sql && db:seed
# Do NOT use db:push --force for transaction/PO schema changes.
# Run it BEFORE rebuilding api/web when the migration is additive — see
# "Schema changes" under "Deploying a new version".
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

## Ext API app connections (consumer apps, e.g. Trade Show)

Each consuming app (Trade Show, etc.) authenticates to `/api/v1/ext/*` with a
Bearer API key tied to a row in `app_connections`. A single Midas app (e.g.
Trade Show) can have more than one connection — for example a `trade_show`
sandbox connection and a separate `trade_show_prod` connection — so that
rotating or scoping one environment's key never touches the other's.

**Issue or rotate a connection's key:**

```bash
cd apps/api
npx tsx src/scripts/create-ext-connection.ts <connection_name>
# e.g.: npx tsx src/scripts/create-ext-connection.ts trade_show_prod
```

- If no connection with that name exists, this **creates** one with the
  Trade Show B4 scopes (`expenses:create`, `expenses:read`,
  `expenses:update`, `expenses:delete`, `receipts:create`,
  `expenses:import`, `ocr:process`) and prints the plaintext API key.
- If a connection with that name **already exists**, this **rotates** its
  key — the old key stops working immediately. Only re-run it against a
  name when you intend to rotate that connection's key.
- **The plaintext API key is printed exactly once and is never recoverable
  afterward** — only its SHA-256 hash (`api_key_hash`) is stored. Copy it
  into the consumer app's secret store (e.g. Trade Show's `MIDAS_API_KEY`)
  immediately, or you will have to rotate again to get a usable key.
- Creating a **new**, differently-named connection does **not** rotate or
  otherwise touch any existing connection's key — verified by comparing
  `api_key_hash` for `trade_show` before and after issuing a sibling
  `trade_show_prod` connection.

**Scope a connection's category vocabulary:**

```bash
npx tsx src/scripts/seed-trade-show-vocabulary.ts <connection_name>
# defaults to "trade_show" if the name is omitted
```

Restricts which of Midas's active expense categories the named connection
can see via `GET /ext/categories`, to the 15-entry flat vocabulary Trade
Show's own UI already uses. Idempotent (safe to re-run — already-present
rows are skipped) and fails loudly (throws) if no connection with the given
name exists. Apply it to every Trade Show connection you create (sandbox,
prod, or any future one) so all of them stay scoped identically.

**`sourceApp` is independent of the connection name — do not change it.**
`category_mappings` rows are keyed on `source_app = 'trade_show'`. The
connection *name* (`trade_show`, `trade_show_prod`, ...) only identifies
*which API key/scope* is making the call — it is not the same field, and
Midas never derives one from the other. A production Trade Show connection
must still send `sourceApp: 'trade_show'` in its request bodies. If a
consumer instead sent `trade_show_prod` as `sourceApp`, all 26 existing
`category_mappings` rows for `trade_show` would silently stop matching and
every OCR suggestion would fail to map to a category. Only the connection
name changes between environments; `sourceApp` in request payloads never
does.

---

## Backup operations

See `docs/BACKUP_RESTORE.md` for full details.

**Primary** (CT 3120, `/opt/midas/backups/`, cron `0 2 * * *` → `/opt/midas/scripts/backup-midas.sh`): pg_dump from CT 3220 + uploads tar, 14-day retention.
**Secondary** (Proxmox host, `/mnt/ssd2/midas-backups/`, cron `15 2 * * *` → `/root/scripts/midas-backup-secondary.sh`): `pct pull` copy of all primary backups to ssd2. **No retention/deletion** on the secondary (copy-only).
**Offsite**: not yet configured — primary + secondary are both on the same physical host, so this is **not** true offsite/DR yet.

> **2026-06-25 fix.** The secondary job had silently no-op'd since ~2026-05-15 ("0 file(s) synced" logged as success). Root cause: cron's default `PATH` (`/usr/bin:/bin`) excludes `/usr/sbin` where `pct` lives, so the source listing came back empty. Fixed by setting `PATH` in both the script and `/etc/cron.d/midas-backup-secondary`, and by making the script **exit nonzero** when 0 files sync (no more phantom success). Verified: 33 files synced, newest secondary copy matches primary.

```bash
# Manual primary backup run
pct exec 3120 -- bash /opt/midas/scripts/backup-midas.sh

# Manual secondary copy to ssd2 (run from Proxmox host, after primary)
bash /root/scripts/midas-backup-secondary.sh        # exits nonzero if 0 files synced

# List primary backups / secondary copies
pct exec 3120 -- ls -lh /opt/midas/backups/
ls -lh /mnt/ssd2/midas-backups/                     # newest db_*/uploads_* should match primary

# Validate latest DB backup (integrity)
pct exec 3120 -- bash -c 'LATEST=$(ls -t /opt/midas/backups/db_*.sql.gz | head -1) && gzip -t "$LATEST" && echo "PASS: $LATEST"'
```

### Restore validation drill (safe — temp DB, never touches production)

`/root/scripts/midas-validate-restore.sh` (runs on the **Proxmox host**) pulls the latest primary DB
dump, restores it into a **temporary** database on CT 3220 as the local `postgres` superuser (peer
auth — no password, no pg_hba change), runs sanity queries, then drops the temp DB. It also
test-extracts the latest uploads archive into a throwaway dir.

```bash
# Run the restore drill (drops temp DB when done; use --keep to inspect)
bash /root/scripts/midas-validate-restore.sh
```

**Good output** ends with:
```
Sanity: public tables=10, users=30, expenses=55
Uploads archive OK (N files): uploads_YYYYMMDD_HHMMSS.tar.gz
PASS: restore validation succeeded against db_YYYYMMDD_HHMMSS.sql.gz
Dropped temp DB midas_restore_verify_...
```

> ⚠️ **Never restore over the production `midas` database.** This drill only ever creates/drops a
> `midas_restore_verify_*` temp DB. A remote restore from CT 3120 is intentionally NOT used because
> pg_hba on CT 3220 only authorizes the `midas` role to connect to the `midas` database.

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

## OCR mode

Current mode: **`mock`** (safe pilot default — no calls to CT 9500, no cost).  
Stage 3 completed 2026-05-14: one real call verified (`job_id=208b79a4`, $0.1015), reverted to mock immediately.  
OCR ledger admin API mismatch (seen during Stage 3) resolved in OCR service v0.11.0 — job lookup by `external_reference_id` now works correctly.

Check active mode:
```bash
ssh root@192.168.1.190 "pct exec 3120 -- docker logs --tail 5 midas-api-1 | grep 'OCR mode'"
# Expected: OCR mode: mock | Zoho mode: mock | Storage: local
```

**Do not switch to `OCR_MODE=service` without explicit operator approval.** Any receipt uploaded while in service mode triggers a real paid OCR call (~$0.10/receipt via document_ai). See `docs/ocr-integration.md` for the exact switching procedure and cost data from Stage 3.

Verify a specific Midas OCR job via OCR admin API (v0.11.0+):
```bash
# Look up Stage 3 job by external_reference_id (secrets redacted)
curl -s -H "X-Admin-Token: <OCR_ADMIN_TOKEN>" \
  "http://192.168.1.195:8000/admin/ledger/job-lookup?external_reference_id=receipt:8ef0e789"
# Or list all Midas jobs:
curl -s -H "X-Admin-Token: <OCR_ADMIN_TOKEN>" \
  "http://192.168.1.195:8000/admin/ledger/jobs?client_app=midas"
```

---

## Zoho Integration

Current mode: **`mock` + `ZOHO_DRY_RUN=true`** (safe default — no calls to CT 9503 or Zoho).

Midas is registered on the Zoho Integration Service (CT 9503) as app `midas` (app_id=2). The Midas credential (60-char token, prefix `e4dce464`) is stored in `/opt/midas/.env` as `ZOHO_SERVICE_TOKEN`. It is not printed in these docs.

Check active Zoho mode:
```bash
ssh root@192.168.1.190 "pct exec 3120 -- docker logs --tail 5 midas-api-1 | grep 'Zoho mode'"
# Expected: OCR mode: mock | Zoho mode: mock | Storage: local
```

Verify Zoho service reachability and Midas token from CT 3120 (safe read-only call):
```bash
ssh root@192.168.1.190 "pct exec 3120 -- python3 -c \"
import urllib.request, json
with open('/opt/midas/.env') as f:
    for l in f:
        if l.startswith('ZOHO_SERVICE_TOKEN='):
            token = l.strip().split('=',1)[1]; break
req = urllib.request.Request('http://192.168.1.205:8000/zoho/organizations/list',
    headers={'Authorization': 'Bearer '+token, 'X-Brand': 'haute_brands'})
with urllib.request.urlopen(req) as r:
    data = json.loads(r.read())
    orgs = data['data']['organizations']
    print('org:', orgs[0]['name'] if orgs else 'none')
\""
# Expected: org: Haute Brands
```

**Do not switch to `ZOHO_MODE=service` or `ZOHO_DRY_RUN=false`** without explicit accounting sign-off on the Zoho Books field mapping. See `docs/ZOHO_INTEGRATION.md` for activation steps.

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
- `oidcAuth.test.ts` — SSO auto-provisioning, resolveDisplayName, SSO-only login guard
- `ocr.test.ts` — OCR mock/service mode tests
- `zohoReadiness.test.ts` — 18 tests for readiness model, payload mapping, version string

---

## Workflow verification

Covers request-info, resolve-request bugfix, payment methods, queue flags, Zoho readiness.

**Credentials are required via env vars — never hardcoded.** On CT 3120, a gitignored
`scripts/.env.test` file holds the real values. To run:

```bash
# From Proxmox host — credentials sourced from .env.test inside CT
ssh root@192.168.1.190 "pct exec 3120 -- bash -c '
  set -a && source /opt/midas/scripts/.env.test && set +a
  bash /opt/midas/scripts/verify-workflows.sh
'"

# Or pass credentials inline (no file on disk):
ssh root@192.168.1.190 "pct exec 3120 -- env \
  MIDAS_TEST_ADMIN_PASSWORD=<admin_pass> \
  MIDAS_TEST_USER_PASSWORD=<user_pass> \
  MIDAS_TEST_ACCOUNTANT_PASSWORD=<acct_pass> \
  bash /opt/midas/scripts/verify-workflows.sh"
```

To set up the credentials file on a new CT:
```bash
cp /opt/midas/scripts/.env.test.example /opt/midas/scripts/.env.test
# Edit .env.test to fill in real password values
```

Expected output: all checks green. Runs in ~5 seconds. Cleans up after itself.

---

## Smoke test

Run from inside CT 3120 (uses localhost, avoids Docker container IP instability):
```bash
# From Proxmox host — credentials sourced from .env.test inside CT
ssh root@192.168.1.190 "pct exec 3120 -- bash -c '
  set -a && source /opt/midas/scripts/.env.test && set +a
  API_URL=http://localhost:4000 WEB_URL=http://localhost:5173 \
    bash /opt/midas/scripts/smoke-test.sh
'"

# Or pass inline:
ssh root@192.168.1.190 "pct exec 3120 -- bash -c '
  API_URL=http://localhost:4000 WEB_URL=http://localhost:5173 \
    MIDAS_TEST_ADMIN_PASSWORD=<admin_password> \
    bash /opt/midas/scripts/smoke-test.sh
'"
```

Or from a dev machine:
```bash
source scripts/.env.test
API_URL=http://192.168.1.210:4000 WEB_URL=http://192.168.1.210:5173 \
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

## Authentik OIDC

Current mode: **`AUTH_MODE=authentik`** with `ALLOW_LOCAL_BREAK_GLASS=true` and `AUTHENTIK_AUTO_CREATE_USERS=true`.

Midas is SSO-first. Users in approved Authentik groups (`midas-admins`, `midas-accountants`, `midas-users`) are auto-provisioned on first sign-in. No-group Authentik users are denied. Local login is break-glass only.

See `docs/AUTHENTIK_SETUP.md` for full setup instructions.

```bash
# Check current auth mode
curl -s http://192.168.1.210:4000/api/v1/auth/config
# {"authMode":"authentik","showLocalLogin":true}

# Revert to local auth (break-glass)
ssh root@192.168.1.190 "pct exec 3120 -- sed -i 's/^AUTH_MODE=.*/AUTH_MODE=local/' /opt/midas/.env"
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose up -d api'"

# Re-enable Authentik SSO
ssh root@192.168.1.190 "pct exec 3120 -- sed -i 's/^AUTH_MODE=.*/AUTH_MODE=authentik/' /opt/midas/.env"
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose up -d api'"
```

### SSO login audit events

| Event | Meaning |
|---|---|
| `sso.login_success` | Successful SSO login (logged every time) |
| `sso.user_auto_created` | New Midas user created on first SSO login |
| `sso.user_linked_by_email` | Existing Midas user linked to Authentik subject by email match |
| `sso.login_denied_no_group` | Authentik user has no approved Midas group |
| `sso.login_denied_inactive_user` | Linked Midas user is deactivated |

### SSO-only users

Auto-provisioned users have `passwordHash=null` — they cannot use local login. To give an SSO user a local fallback password: Admin → Users → Reset Password. This sets a local password alongside their SSO link.

---

## Environment file

Location: `/opt/midas/.env` on CT 3120.

**Important:** `docker compose restart` does NOT reload the `env_file`. After editing `.env` you must recreate the container:
```bash
# Correct — recreates the container and re-reads .env
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose up -d api'"

# Wrong — does NOT reload env changes (only restarts the process inside the same container)
# pct exec 3120 -- docker compose restart api
```

Verify the new env took effect by checking the startup log:
```bash
ssh root@192.168.1.190 "pct exec 3120 -- docker logs --tail 5 midas-api-1"
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
# The migrator service is defined in docker-compose.prod.yml only (the base
# file has none), and --build is required so it picks up the current drizzle/.
pct exec 3120 -- docker compose -f /opt/midas/docker-compose.prod.yml run --rm --build migrator
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

---

## Production security checklist

Verified in code (server.ts / config/env.ts) and required before any shared or production deployment:

- **Uploads are auth-only.** Receipt and capture files are served exclusively through
  `GET /api/v1/files/receipts/:receiptId` and `GET /api/v1/files/captures/:captureId`
  (session cookie auth; owner or accountant/admin — developer passes). The public
  `express.static('/uploads')` mount has been removed; no unauthenticated file access exists.
- **`COOKIE_SECURE=true` in production.** The JWT session cookie must be Secure (requires HTTPS
  at the proxy). Keep `false` only for local HTTP dev.
- **`JWT_SECRET` at least 32 characters,** unique per environment. Enforced at boot by env
  validation (the API refuses to start otherwise).
- **Helmet is enabled** and the auth login route is rate-limited (`AUTH_RATE_LIMIT_MAX`,
  default 20 attempts / 15 min / IP — production-safe; only raise it for dev/LAN).
- **CORS is an allowlist:** the configured `CORS_ORIGIN` plus browser-extension schemes
  (`chrome-extension://`, `moz-extension://`, which still require a valid session cookie).
  Do not widen it.
- **SMTP secrets stay server-side.** `SMTP_HOST/PORT/USER/PASS/FROM` live only in the API
  container's `.env` — never in web build args, client code, or the repo.
- **Invite links are single-use and expire after 7 days** (`invite_token` +
  `invite_expires_at`; the token is cleared on acceptance).
- **Rotate or deactivate seeded users before pilot.** All `*@midas.local` seed accounts —
  especially `partner@midas.local` and `developer@midas.local` (developer passes every role
  gate) — must have their passwords rotated or the accounts deactivated before connecting to
  a shared environment.
- **Closed periods lock accounting months.** Once a month is closed
  (accountant dashboard → Closed Periods), expenses dated in it cannot be edited, deleted,
  submitted, reviewed, or have reimbursement changed; admin force-delete is the audited
  override and reopening a period is admin-only and audited.

## User registration (Authentik-driven)

Registration is fully automatic — there is no manual Midas account creation for
SSO users:

1. **Grant access in Authentik**: add the person to one of the Midas groups
   (admin / accountant / user mapping via `AUTHENTIK_GROUP_*`).
2. **They sign in** with the SSO button on the Midas login page.
3. On first sign-in Midas **auto-creates their account**
   (`AUTHENTIK_AUTO_CREATE_USERS=true` in prod): email + display name from the
   Authentik profile, initial role from their group, SSO-only (no local
   password), and the SSO link is stored for future logins.
4. After creation, **Midas owns the role** — promote to partner/developer or
   change roles in Settings → People; Authentik groups only gate app access.
5. Someone signing in with no approved group is denied (`denied_no_group`) and
   no account is created.

Non-SSO users (rare) are onboarded via Settings → People → Invite User
(one-time 7-day link where they set a password).
