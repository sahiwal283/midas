# Ext API sandbox handoff (local)

**Date:** 2026-08-03  
**Goal:** Trade Show BFF can call Midas Ext on sandbox / local.

**→ Trade Show agent: use [`docs/TRADE_SHOW_AGENT_HANDOVER.md`](./TRADE_SHOW_AGENT_HANDOVER.md) as the primary integration brief.**

## Local instance (this machine)

| Item | Value |
|---|---|
| API (loopback) | `http://localhost:4000/api/v1` |
| API (LAN — CT 2600) | `http://192.168.8.102:4000/api/v1` (`HOST=0.0.0.0`) |
| Web (midasUrl base) | `http://192.168.8.102:5173` (also `localhost:5173`) |
| OCR | `OCR_MODE=mock` (swap to `service` + token for parity tests) |
| Auto-provision | `EXT_AUTO_PROVISION_USERS=true` |
| JSON body limit | `100mb` (import batches with base64 receipts) |
| App connection | `trade_show` with B4 scopes |

**Migration reply for Trade Show agent:** [`docs/TRADE_SHOW_MIGRATION_REPLY.md`](./TRADE_SHOW_MIGRATION_REPLY.md)

### API key

Shown once at create time; stored locally (gitignored) as `.ext-sandbox.key`.

Trade Show env:

```bash
MIDAS_MODE=live
MIDAS_BASE_URL=http://localhost:4000/api/v1
MIDAS_API_KEY=<contents of midas .ext-sandbox.key>
MIDAS_WEB_BASE_URL=http://localhost:5173
EXPENSE_BACKEND=midas   # or dual after adapter lands
EXT / MIDAS_TIMEOUT_MS=120000
```

Rotate / recreate:

```bash
set -a && source .env && set +a
npm run ext:create-connection --workspace=@midas/api -- trade_show
```

### Verified smoke (2026-08-03)

Full Required surface via `npm run ext:smoke`:

```
PASS  GET /ext/categories
PASS  POST /ext/ocr/process
PASS  POST /ext/expenses (create + idempotent)
PASS  PATCH /ext/expenses/:id
PASS  POST /ext/expenses/:id/receipts (sync OCR)
PASS  GET …/receipts/:id/content
PASS  GET /ext/expenses/:id (full DTO)
PASS  GET /ext/expenses?eventId=
PASS  GET /ext/expenses/by-ref
PASS  POST /ext/expenses/import (skipOcr + idempotent skip)
PASS  DELETE /ext/expenses/:id (+ 404 after)
PASS  Invalid key → 401
```

Re-run:

```bash
export MIDAS_API_KEY=$(cat .ext-sandbox.key)
export MIDAS_BASE_URL=http://localhost:4000/api/v1
npm run ext:smoke --workspace=@midas/api
```

## Ops checklist for CT sandbox / prod later

1. Deploy API with schema:
   - `db:push`, **or**
   - `psql "$DATABASE_URL" -f apps/api/drizzle/0002_ext_trade_show_merge.sql`
2. `db:seed` (Trade Show categories + mappings)  
3. `ext:create-connection trade_show` → give key to Trade Show ops  
4. Sandbox: `EXT_AUTO_PROVISION_USERS=true`  
5. Prod: prefer `false` + preflight user report  
6. Point `OCR_MODE=service` at CT 9500 when ready for OCR parity  

## Curl helpers

```bash
export MIDAS_BASE_URL=http://localhost:4000/api/v1
export MIDAS_API_KEY=$(cat .ext-sandbox.key)
./scripts/ext-curl-examples.sh categories
./scripts/ext-curl-examples.sh create
./scripts/ext-curl-examples.sh list
```

## Spec

- `docs/EXT_API_MERGE_LOCK.md`  
- `docs/CONTRACT_ALIGNMENT.md` (COMPLETE)  

