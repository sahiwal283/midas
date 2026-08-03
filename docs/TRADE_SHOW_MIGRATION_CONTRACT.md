# Midas ↔ Trade Show App — Migration Contract (Midas Offer)

**Document type:** Bilateral interface + cutover contract  
**Issued by:** Midas (canonical Expense Engine)  
**Issued to:** Trade Show App (expense consumer / embedder)  
**Status:** **COMPLETE (dual-app)** — Ext sandbox implementation authorized  
**Date:** 2026-08-03  
**Rule:** Implement per `docs/EXT_API_MERGE_LOCK.md` on sandbox; production TS cutover still Phase 4/5.

**Authoritative alignment:** [`docs/CONTRACT_ALIGNMENT.md`](./CONTRACT_ALIGNMENT.md) (**ALIGNED**, TS B1–B12 countersigned)  
**Locked Ext API + schemas:** [`docs/EXT_API_MERGE_LOCK.md`](./EXT_API_MERGE_LOCK.md)  
**TS inputs:** Implementation Contract + Merge Contract + Alignment Response (2026-08-03).

---

## 0. How to use this document

1. **Midas** publishes this offer (this file).
2. **Trade Show** publishes a matching counter-contract (same section numbers) stating what Trade Show will own, call, migrate, and remove.
3. Both sides fill **§16 Alignment checklist** — every row must be `AGREED` or `DEFERRED (with owner + date)`.
4. Only then may either side merge code that routes live expenses through Midas or deletes Trade Show expense OCR/storage.

Related Midas docs (normative where linked):

| Topic | Doc |
|---|---|
| Sync / offline | `docs/SYNC_AND_OFFLINE.md` |
| OCR subsystem | `docs/OCR_ENGINE.md` |
| Embedding strategies | `docs/EMBEDDING.md` |
| Historical field mapping | `docs/MIGRATION_PLAN.md` |
| Import framework | `docs/IMPORT_FRAMEWORK.md` |
| HTTP shapes | `docs/API_CONTRACTS.md` |

---

## 1. Purpose & non-goals

### 1.1 Purpose

Make **Midas the sole system of record for expenses, receipts, OCR, accountant review, reimbursement, Zoho push, and expense conversation**, while Trade Show retains **event / booth / logistics / checklist** domain logic and deep-links into Midas for expense UX where needed.

### 1.2 Non-goals (explicit)

| Non-goal | Owner after cutover |
|---|---|
| Trade show events, booths, venues, attendees, logistics | Trade Show (later Argo) — **not** Midas |
| Hardcoding `trade_show` special cases inside Midas core | Forbidden — use opaque `OwnerRef` only |
| Rewriting Trade Show OCR heuristics “to improve” them | Forbidden — OCR parity is locked (see §5) |
| Two-way continuous sync of expense status into Trade Show DB as source of truth | Out of scope — Midas is SoR; Trade Show may *read* status |
| Migrating non-expense Trade Show data into Midas | Out of scope |

---

## 2. System of record (ownership)

| Concern | System of record | Notes |
|---|---|---|
| Expense record (merchant, amount, date, status, reimbursement) | **Midas** | |
| Receipt files + OCR metadata | **Midas** | Same OCR pipeline Trade Show users already trust |
| Accountant review / ask-for-info / approve / reject | **Midas** | |
| Zoho expense push | **Midas** → Zoho Integration Service | |
| In-app expense conversation | **Midas** (`expense_messages`) | Telegram notify-only if used |
| Audit trail for expense actions | **Midas** (`audit_logs`) | |
| Event / booth / show context | **Trade Show** (→ Argo later) | Linked via `OwnerRef` + `sourceLabel` / `sourceUrl` |
| Offline “pending upload” UX at the show | **Client** (Trade Show and/or Midas web) | See §6 — not a Midas server async job queue |
| User identity | Shared by **email** (Authentik later) | Midas user must exist before expense create |

**Invariant:** After cutover, Trade Show **must not** persist a parallel authoritative expense/receipt/OCR store. Local caches/queues are allowed only as offline safety nets that eventually POST to Midas.

---

## 3. Polymorphic ownership (`OwnerRef`)

Every expense created from Trade Show **must** carry:

| Wire / DB (Midas) | Embedder name | Required value |
|---|---|---|
| `sourceApp` | `ownerType` | Stable string chosen by Trade Show, e.g. `trade_show` (opaque to Midas) |
| `sourceRefId` | `ownerId` | Stable id of the Trade Show expense (or booth-expense key) — **idempotency key** |
| `sourceLabel` | — | Human context, e.g. `Expo West 2026 — Booth 42` |
| `sourceUrl` | — | Deep link back into Trade Show UI for that record |

Helpers in `@midas/shared`: `OwnerRef`, `toOwnerRef`, `fromOwnerRef`.

**Idempotency:** Unique index on `(sourceApp, sourceRefId)`. Re-POSTing the same pair must **not** create a duplicate (skip or return existing — see §8 gaps).

Trade Show **must not** invent a second identity scheme for the same logical expense.

---

## 4. Integration strategy (runtime)

### 4.1 Chosen strategy (Midas recommendation)

**Strategy A — Service delegation** (`docs/EMBEDDING.md`):

- Trade Show UI/backend calls Midas HTTP APIs (session cookie for human flows and/or Bearer app key for server-to-server).
- Trade Show does **not** run OCR providers, does **not** store receipt binaries as SoR, does **not** run accountant review.

**Strategy B** (npm packages in-process) is available for OCR/import libraries only; full UI/API embed is **not** required for this cutover.

### 4.2 Auth

| Caller | Auth | Notes |
|---|---|---|
| Browser user in Midas web | httpOnly JWT cookie | Existing Midas auth |
| Trade Show server → Midas | `Authorization: Bearer <app_key>` on `/api/v1/ext/*` | Key from `POST /api/v1/admin/connections` |
| Trade Show browser → Midas (if same-site / SSO later) | TBD in alignment — cookie vs token exchange | **Must be answered in Trade Show counter-contract** |

Users are matched by **email**. Creating an expense for an email with no Midas user returns `422 USER_NOT_FOUND`.

---

## 5. OCR contract (exact parity)

### 5.1 Single pipeline

There is **one** OCR implementation for receipts:

1. Client preprocess (ImageMagick HEIC→JPEG, auto-orient, resize ≤2000) — `@midas/ocr-client`
2. Live engine CT 9500 `http://192.168.1.195:8000` — RapidOCR primary, Document AI fallback
3. Rule-based enrichment — **verbatim** Trade Show `RuleBasedInferenceEngine` + category keyword taxonomy

Verified side-by-side 2026-08-03 (same receipt → identical text, provider, field values/confidences).

### 5.2 Runtime rules

| Rule | Value |
|---|---|
| Default OCR mode in Midas | **Live** (`OCR_MODE=service`) |
| Happy-path receipt upload | **Synchronous** — response includes completed OCR |
| Escape hatch | `?async=1` only when caller cannot wait |
| Polling OCR as primary UX | **Forbidden** |
| Trade Show keeps own OCR service client long-term | **Forbidden after cutover** |
| Changing inference heuristics without parity re-test | **Forbidden** |

Normative detail: `docs/OCR_ENGINE.md`, `docs/SYNC_AND_OFFLINE.md`.

### 5.3 OCR suggestions vs Midas categories

OCR category **suggestions** use the expense-app taxonomy strings (e.g. `Meal and Entertainment`, `Booth / Marketing / Tools`).  
Midas **DB** `expense_categories` are a separate list (seeded names differ). Trade Show counter-contract must specify:

- Whether UI shows OCR suggestion as free text until accountant maps it, **or**
- A mapping table from OCR suggestion → Midas `categoryId`.

---

## 6. Sync model (live + offline safety net)

Normative: `docs/SYNC_AND_OFFLINE.md`.

| Path | Behavior |
|---|---|
| **Online (default)** | Synchronous HTTP to Midas; wait for expense + OCR in the response |
| **Offline / flaky** | Client queues work in a **To upload** list; drains by calling the same sync APIs when online |

Clarifications:

- Midas API is **not** “accept now, process later” for expense create on the happy path.
- Trade Show may keep its existing IndexedDB sync queue **if** the drain target becomes Midas (not Trade Show’s own expense tables).
- Midas web also ships `/to-upload` for standalone use.

---

## 7. Live API surface Trade Show will use

### 7.1 Available today (Midas)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/ext/expenses` | Create expense (Bearer key); body includes `sourceApp`, `sourceRefId`, `submitterEmail`, merchant/amount/date/… |
| `GET` | `/api/v1/ext/expenses/:id` | Read status slice |
| `POST` | `/api/v1/expenses` | Session-auth create (human in Midas UI) |
| `POST` | `/api/v1/expenses/:id/receipts` | Upload receipt + **sync OCR** (field name `file`) |
| `GET/PATCH` | `/api/v1/expenses…`, accountant routes | Review workflow in Midas UI |

### 7.2 Gaps Trade Show must call out (Midas will implement only if AGREED)

Current `/api/v1/ext/` is **create + status get** only. For a full embed without bouncing users into Midas UI for every step, Trade Show’s counter-contract should mark each as Required / Not needed:

| Capability | Status in Midas today | Trade Show must say |
|---|---|---|
| Ext receipt upload + sync OCR | **Missing** on `/ext` | Required? |
| Ext update expense fields | **Missing** | Required? |
| Ext submit / status transition | **Missing** (creates as `draft`) | Required? |
| Ext list by `OwnerRef` | **Missing** | Required? |
| Ext attach `sourceLabel` / `sourceUrl` / payment method | **Partial** (not all on create schema) | Required fields? |
| Idempotent create (return existing on conflict) | **DB unique**; API may 500 on conflict today | Require 200 + existing? |
| Webhook / push status to Trade Show | **Not provided** | Required or poll only? |

Until gaps are AGREED and shipped, the interim UX is: create/link in Midas + deep-link users to Midas for receipt/review where needed.

---

## 8. Historical data migration

Uses `@midas/import` + `DrizzleImportTargetPort` + Trade Show-authored `ImportSource`.

### 8.1 Order

1. Categories (by name)  
2. Users (by email)  
3. Payment methods  
4. Expenses (`OwnerRef` = Trade Show ids)  
5. Receipts + files + OCR metadata  
6. Notes → `expense_messages`  
7. Audit history (or single `expense.migrated` synthetic event)

### 8.2 Preservation requirements

Preserve when present: ids (best-effort `preserveId`), timestamps, OCR metadata, attachments, categories, notes, audit history.

### 8.3 Status / reimbursement mapping

As in `docs/MIGRATION_PLAN.md` (Trade Show status → Midas enum). Trade Show counter-contract must attach the **exact** enum values their DB uses today so the mapping table can be locked.

### 8.4 Dry-run

`npm run import:run --workspace=@midas/api -- ./export.json --dry-run` before any write.

### 8.5 What does **not** migrate

Event/booth/logistics records, Trade Show-only checklist reservation parsing as Midas domain, duplicate OCR engine deployment as SoR.

---

## 9. UI / UX cutover

| Surface | During dual-run | After cutover |
|---|---|---|
| Trade Show “submit expense” | Dual-write **or** write-only-to-Midas (AGREED in §16) | Midas only |
| OCR results UI | Must show Midas sync OCR response | Same |
| Accountant review | Midas `/accountant` | Midas only |
| Deep link from booth → expense | `sourceUrl` / Midas `/expenses/:id` | Required |
| Trade Show expense tables | Read-only freeze after cutover date | Deprecated / removed |

Trade Show counter-contract must name **screens/routes** that will be deleted or redirected.

---

## 10. Zoho

| Item | Contract |
|---|---|
| Who pushes to Zoho | **Midas only** after cutover |
| Trade Show embedded Zoho paths | Disabled / removed |
| Dry-run gate | `ZOHO_DRY_RUN` remains until explicitly cleared |
| Existing Zoho expense ids on migrated rows | Preserved on `zoho_expense_id` when known |

---

## 11. Environments & hosts (current LAN)

| System | Host | Notes |
|---|---|---|
| Midas app | CT 3120 (`/opt/midas`) | `OCR_MODE=service` |
| Midas DB | CT 3220 | |
| OCR engine | CT 9500 `192.168.1.195:8000` | Shared live engine |
| Trade Show backend | CT 2220 | |
| Trade Show frontend | CT 2120 | |

Secrets (OCR token, app keys) never committed; rotated via operators.

---

## 12. Security & compliance

- App keys: shown once at issue time; stored only hashed in Midas.
- OCR token: server-side only; never in Trade Show frontend bundles.
- Cookies: `COOKIE_SECURE=true` in production HTTPS.
- No PII in OCR attribution headers beyond opaque receipt ids.
- Audit logs append-only.

---

## 13. Rollback

| Phase | Rollback |
|---|---|
| Before cutover | Trade Show continues local expenses; Midas import dry-runs only |
| Dual-run | Feature flag: Trade Show writes local SoR again; Midas data retained |
| Post-cutover | Re-enable Trade Show write path only with explicit user approval; Midas remains backup SoR until confirmed |

No silent deletion of Trade Show expense tables until **both** contracts mark cutover complete.

---

## 14. Acceptance tests (must pass before merge)

1. **OCR parity:** Same receipt file through Trade Show legacy path and Midas path → matching text + core fields (merchant/amount/date/card/category confidence within float epsilon).  
2. **Sync create:** Online create + receipt upload returns `ocrStatus` done/failed in one response (< OCR timeout).  
3. **Idempotency:** Two creates with same `OwnerRef` → one Midas expense.  
4. **Offline safety:** Disconnect → item appears in To upload (Trade Show and/or Midas) → reconnect → appears in Midas.  
5. **Import dry-run:** Sample export reports totals with zero writes.  
6. **Import apply (staging):** Sample N expenses with receipts; spot-check UI.  
7. **Zoho:** Still mock/dry-run unless separately approved.

---

## 15. Trade Show counter-contract — required sections

Trade Show must return a document with **the same section numbers (1–14)** plus:

### 15.1 Required answers (fill in)

| # | Question | Trade Show answer |
|---|---|---|
| A | Stable `ownerType` string? | |
| B | Exact `ownerId` scheme (UUID of expense? composite?) | |
| C | Auth mode for browser vs server calls to Midas? | |
| D | Dual-run duration and feature-flag name? | |
| E | Which `/ext` gaps in §7.2 are Required for launch? | |
| F | OCR suggestion → Midas category mapping approach? | |
| G | Exact status/reimbursement enums in Trade Show DB today? | |
| H | Screens/routes to remove after cutover? | |
| I | Who owns offline queue after cutover (TS syncManager vs Midas `/to-upload`)? | |
| J | Cutover date target / freeze window? | |
| K | Any data Trade Show believes must stay in TS DB post-cutover? | |

### 15.2 Explicit disagreements

List any row where Trade Show **rejects** a Midas MUST/ Forbidden above, with rationale and proposed alternative.

---

## 16. Alignment checklist (both sides)

**Canonical checklist:** `docs/CONTRACT_ALIGNMENT.md` §9.

Snapshot after Trade Show Merge Contract absorption (2026-08-03):

| ID | Topic | Midas | Trade Show | Notes |
|---|---|---|---|---|
| C1–C12 | Ownership, OCR, Ext lock, import, UI, Zoho, rollback | AGREED | AGREED (pending status flip) | See alignment doc |
| C13 | Coding gate | Open after TS COMPLETE mirror | flip status file | Ext lock: `EXT_API_MERGE_LOCK.md` |

**Merge gate:** Coding starts when Trade Show alignment status = COMPLETE.

---

## 17. Sign-off

| Role | Name | Date | Signature |
|---|---|---|---|
| Midas owner | | | |
| Trade Show owner | | | |
| Operator (deploy) | | | |

---

## 18. Document control

| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-08-03 | Midas | Initial full migration contract offer |
| 0.2 | 2026-08-03 | Midas | Consolidated Implementation Contract received; alignment opened |
| 0.3 | 2026-08-03 | Midas | TS Merge Contract absorbed; Ext API locked |
| 0.4 | 2026-08-03 | Midas | Countersigned TS alignment response; **ALIGNED**; scopes required; appendix published |

**Trade Show:** set alignment status → **COMPLETE**. Then both sides may plan/implement on sandbox only.

