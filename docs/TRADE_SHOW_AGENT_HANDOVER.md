# Trade Show Agent Handover — Midas Ext Expense Engine

**From:** Midas agent  
**To:** Trade Show App agent  
**Date:** 2026-08-03  
**Alignment:** COMPLETE (dual-app) — coding authorized  
**Midas Ext status:** **READY for Trade Show BFF integration (sandbox)**

This document is everything Trade Show needs to implement `MidasClient` / `MidasExpenseStore` against a live Midas Ext API. Normative API detail remains in `docs/EXT_API_MERGE_LOCK.md`; this is the operational handover.

---

## 1. What Midas has delivered

| Deliverable | Status |
|---|---|
| Required Ext API (OCR, CRUD, list, by-ref, receipts, import, categories) | Done |
| Bearer app key + scope enforcement (`MISSING_SCOPE`) | Done |
| Sync OCR standalone + sync receipt OCR (`?async=1` escape) | Done |
| `source_context` / `external_user_id` / filterable `eventId` | Done |
| Idempotent create on `(sourceApp, sourceRefId)` → 200 + `created:false` | Done |
| Default Ext create status `pending` | Done |
| Reimbursement enum includes `rejected` | Done |
| Category seed (exact TS names) + `category_mappings` for OCR suggestions | Done |
| HTTP import with `dryRun`, `skipOcr`, checksums, timestamps, Zoho ids | Done |
| `midasUrl` on expense responses | Done |
| User auto-provision (`EXT_AUTO_PROVISION_USERS`) | Done |
| Migration SQL `apps/api/drizzle/0002_ext_trade_show_merge.sql` | Done |
| Local sandbox smoke (15 checks) | Green |
| Admin UI: create key with scopes + revoke | Done |

**Deferred (not required for Trade Show v1):** Ext `review` / `reimbursement` / `zoho-push` routes — accountants use Midas UI via `midasUrl`.

---

## 2. Connect now (local Midas sandbox)

| Variable | Value |
|---|---|
| `MIDAS_MODE` | `live` (or `mock` until your client is ready) |
| `MIDAS_BASE_URL` | Laptop: `http://localhost:4000/api/v1` · CT 2600: `http://192.168.8.102:4000/api/v1` |
| `MIDAS_API_KEY` | Ask Midas ops for current key, or read Midas repo `.ext-sandbox.key` (gitignored) if you share the machine |
| `MIDAS_WEB_BASE_URL` | `http://192.168.8.102:5173` (LAN) or `http://localhost:5173` |
| `MIDAS_TIMEOUT_MS` | `120000` (OCR can be slow in service mode) |

**Zero-loss migration reply (G1–G8):** [`docs/TRADE_SHOW_MIGRATION_REPLY.md`](./TRADE_SHOW_MIGRATION_REPLY.md)

**Scopes on the key (must all be present):**

```
expenses:create, expenses:read, expenses:update, expenses:delete,
receipts:create, expenses:import, ocr:process
```

Rotate / recreate (Midas side):

```bash
npm run ext:create-connection --workspace=@midas/api -- trade_show
```

Smoke (Midas side):

```bash
export MIDAS_API_KEY=… MIDAS_BASE_URL=http://localhost:4000/api/v1
npm run ext:smoke --workspace=@midas/api
```

Curl helpers (Midas repo):

```bash
./scripts/ext-curl-examples.sh categories|ocr|create|list|by-ref|import-dry
```

---

## 3. Identity & headers (every mutating call)

| Field | Required | Notes |
|---|---|---|
| `Authorization: Bearer <key>` | Yes | Never put key in browser |
| `submitterEmail` (JSON) or `X-Actor-Email` | Yes on create/mutate | Ownership join key |
| `X-Actor-External-User-Id` | Yes for filters/audit | Trade Show `users.id` UUID |
| `X-Actor-Name` | Preferred | Display name for provision/audit |
| `X-Request-Id` | Optional | Correlation |

**User resolution:** email → existing Midas user, else auto-create if `EXT_AUTO_PROVISION_USERS=true` (sandbox), else `422 USER_NOT_FOUND`.

---

## 4. Locked constants

| Constant | Value |
|---|---|
| `sourceApp` | `trade_show` (exact) |
| `sourceRefId` | Trade Show `expenses.id` UUID (stable forever) |
| `sourceType` | `trade_show_event` |
| `eventId` | Trade Show `events.id` UUID → stored in `sourceContext.eventId` |
| List filter | `GET /ext/expenses?sourceApp=trade_show&eventId=<uuid>&externalUserId=<uuid>` |

**ID policy:** Midas generates new expense UUIDs. Keep legacy id in `sourceRefId`. Lookup: `GET /ext/expenses/by-ref?sourceApp=trade_show&sourceRefId=…`.

---

## 5. Recommended BFF call sequence (intake UX)

Matches today’s Trade Show “OCR → fill form → save” feel:

```
1. POST /ext/ocr/process          multipart file
   → show fields (merchant/amount/date/category/…)

2. POST /ext/expenses             JSON (status pending, eventId, sourceRefId, …)
   → { expense, midasUrl, created }

3. POST /ext/expenses/:id/receipts   multipart file
   → sync OCR stored on receipt (may skip if you already ran standalone OCR;
     still upload bytes so SoR has the file)

4. GET /ext/expenses?sourceApp=trade_show&eventId=…   for list mirror
5. PATCH /ext/expenses/:id   while status ∈ draft|pending|awaiting_info
6. DELETE only if draft OR (pending ∧ unreviewed ∧ no zohoExpenseId)
```

**Accountant / Zoho / approve-reject:** do **not** call Ext review APIs. Deep-link:

`expense.midasUrl` → e.g. `http://localhost:5173/expenses/<midas-id>`

---

## 6. Status maps (must use these)

### Expense status

| Trade Show | Midas |
|---|---|
| `pending` | `pending` |
| `needs further review` | `awaiting_info` |
| `approved` | `approved` |
| `rejected` | `rejected` |
| *(Midas-only)* | `draft`, `in_review`, `zoho_sync_failed` |

### Reimbursement

| Trade Show | Midas |
|---|---|
| not required | `not_requested` |
| pending review | `pending` |
| approved | `approved` |
| rejected | `rejected` |
| paid | `paid` |

---

## 7. Categories

`GET /ext/categories` returns seeded names. Exact production names include:

`Booth / Marketing / Tools`, `Travel - Flight`, `Accommodation - Hotel`, `Transportation - Uber / Lyft / Others`, `Parking Fees`, `Rental - Car / U-haul`, `Meal and Entertainment`, `Gas / Fuel`, `Shipping Charges`, `Show Allowances - Per Diem`, `Travel Expenses`, `Model`, `Other`

On create/import you may send `categoryName` (exact or OCR suggestion). Midas resolves via name → `category_mappings` → else `Other` + import warning.

---

## 8. Migration import

`POST /ext/expenses/import`

- Batch JSON, `dryRun: true` first  
- Idempotent: re-run → `skipped` for existing `(sourceApp, sourceRefId)`  
- Receipt: `contentBase64` + `skipOcr: true` + `ocrText` / `extractedData` (do **not** re-bill OCR)  
- Preserve `createdAt` / `updatedAt` / Zoho ids when provided  
- Prod scale ~377 rows — sync OK  

---

## 9. Error shape

```json
{ "error": { "code": "SNAKE_CASE", "message": "…" } }
```

Common codes: `UNAUTHENTICATED`, `MISSING_SCOPE`, `USER_NOT_FOUND`, `USER_INACTIVE`, `VALIDATION_ERROR`, `CONFLICT`, `NOT_FOUND`, `NO_FILE`.

---

## 10. What Trade Show should build next

1. `MidasClient` (disabled | mock | live)  
2. `ExpenseStore` + `MidasExpenseStore` + feature flags (`MIDAS_MODE`, `EXPENSE_BACKEND`)  
3. Facade: keep external `/api/expenses*` shapes; route to Ext  
4. Facade: `/api/ocr/v2/process` → `POST /ext/ocr/process`  
5. Permissions stay in TS BFF (salesperson = own via `externalUserId`)  
6. Remove local OCR/Zoho/accountant SoT after `EXPENSE_BACKEND=midas`  
7. Migration runner → `POST /ext/expenses/import` (dry-run then apply)  
8. Sandbox-only deploys until Phases validated  

---

## 11. Acceptance (Trade Show fills after sandbox)

Use Merge Contract §14 / Implementation Contract §16. Minimum:

- [ ] Create event expense from TS → appears in TS list + Midas UI  
- [ ] Receipt upload + OCR fields populate before save  
- [ ] Edit pending works; approved locked  
- [ ] Permissions unchanged (salesperson vs admin)  
- [ ] Import count = TS event expenses; re-import 0 duplicates  
- [ ] Receipts open; OCR preserved with `skipOcr`  
- [ ] Zoho ids preserved where present  
- [ ] Open in Midas deep link works  
- [ ] No direct TS OCR microservice calls  

---

## 12. CT / remote sandbox (later)

When promoting off localhost:

1. Deploy Midas API with schema (`db:push` or `0002_ext_trade_show_merge.sql`)  
2. `db:seed`  
3. Issue `trade_show` connection with scopes above  
4. `EXT_AUTO_PROVISION_USERS=true` on sandbox; prefer `false` + preflight users in prod  
5. `OCR_MODE=service` + CT 9500 token for OCR parity  
6. Point Trade Show `MIDAS_BASE_URL` / `MIDAS_API_KEY` at that host  

---

## 13. Spec index (Midas repo)

| Doc | Role |
|---|---|
| `docs/EXT_API_MERGE_LOCK.md` | **Normative** request/response/paths |
| `docs/CONTRACT_ALIGNMENT.md` | Dual-app ALIGNED / COMPLETE record |
| `docs/TRADE_SHOW_MIGRATION_CONTRACT.md` | Cutover ownership |
| `docs/EXT_SANDBOX_HANDOFF.md` | Local ops notes |
| `docs/API_CONTRACTS.md` § Ext | Summary table |
| `docs/SYNC_AND_OFFLINE.md` | Sync-primary OCR model |
| `scripts/ext-curl-examples.sh` | Curl sketches |
| `apps/api/src/scripts/ext-smoke.ts` | Conformance smoke |

---

## 14. Contact / ownership

| Workstream | Owner |
|---|---|
| Ext API bugs, schema, import, categories, keys | Midas agent |
| BFF, flags, migration runner, TS UI, sandbox TS deploy | Trade Show agent |
| Shared OCR microservice | Existing OCR ops (Midas is only TS path after cutover) |

**Do not change the Ext API unilaterally.** If a path/field must change, update `EXT_API_MERGE_LOCK.md` + alignment first.

---

**Midas side for Trade Show v1 Ext integration is complete.** Trade Show may proceed with sandbox BFF against the lock above.
