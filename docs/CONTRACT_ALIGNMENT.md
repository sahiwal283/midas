# Midas ↔ Trade Show — Contract Alignment

**Alignment state:** COMPLETE (dual-app)  
**Date:** 2026-08-03  
**C13 coding gate:** **OPEN** — Trade Show COMPLETE mirrored; D1 `sourceContext` ACK’d.  
Ext sandbox implementation may proceed per `docs/EXT_API_MERGE_LOCK.md`.

| Input | Role |
|---|---|
| Trade Show → Midas Alignment Response (2026-08-03) | Countersigned below (B1–B12, A–K) |
| Trade Show Merge Contract / Implementation Contract | Behavior + Ext ask |
| `docs/EXT_API_MERGE_LOCK.md` | Locked Ext paths + schemas appendix |
| This file | Shared ALIGNED record |

---

## 1. Verdict

| Gate | State |
|---|---|
| B1–B12 | **COUNTERSIGNED** (see §2; minor syntax notes only) |
| A–K | **ACCEPTED** |
| Required Ext path list (B3) | **LOCKED** |
| `sourceContext` + filters (B5) | **LOCKED** |
| OCR-without-expense (B6) | **LOCKED** |
| Schema / API appendix | **Published** → `docs/EXT_API_MERGE_LOCK.md` |
| Sandbox app key + scopes | **Phase 0 ops** (plan locked; issue at deploy) |
| **Alignment** | **COMPLETE (dual-app)** |

---

## 2. Countersign B1–B12

| ID | Trade Show decision | Midas |
|---|---|---|
| **B1** | Add `rejected` to `reimbursement_status` | **COUNTERSIGNED** |
| **B2** | OwnerRef hard-required on Ext/import (`sourceApp`,`sourceRefId`); TS always sends label/url/type; nullable on Midas-native; `sourceType` open vocab incl. `null`, `online_receipt`, `manual`, `trade_show_event` | **COUNTERSIGNED** — Ext will require `sourceLabel` + `sourceType` when `sourceApp=trade_show`; `sourceUrl` optional |
| **B3** | Required Ext set (OCR, CRUD/list, receipts, import, categories); DEFER review / reimbursement / zoho-push | **COUNTERSIGNED** — paths locked in `EXT_API_MERGE_LOCK.md` |
| **B4** | Normative scopes; missing → 403 `FORBIDDEN` / `MISSING_SCOPE`; assign at key issue | **COUNTERSIGNED** *(supersedes earlier “scopes deferred” note)* |
| **B5** | No `event_id` column; opaque `source_context` jsonb; `externalUserId` = TS `users.id` | **COUNTERSIGNED** — see filter syntax note below |
| **B6** | Sync OCR-without-expense; no expense/receipt SoR persist | **COUNTERSIGNED** |
| **B7** | Hard-delete only if `draft` OR (`pending` ∧ never reviewed ∧ no `zohoExpenseId`); else 409; retain audit; GC blobs on success | **COUNTERSIGNED** |
| **B8** | `EXT_AUTO_PROVISION_USERS`; sandbox **true**; prod prefer **false** + preflight | **COUNTERSIGNED** — env default **`false`**; sandbox ops sets `true` |
| **B9** | Seed names + OCR→category map in TS response §3; unmapped → Other + warning | **COUNTERSIGNED** — stored as data (`expense_categories` + `category_mappings`); no TS literals in code paths |
| **B10** | Users → Categories → Payment Methods → Expenses → Receipts → OCR → Notes → Audit | **COUNTERSIGNED** |
| **B11** | `POST /ext/expenses/import` wraps CLI framework; JSON body; `dryRun`; per-item results | **COUNTERSIGNED** |
| **B12** / A–K | All answered | **ACCEPTED** (see §3) |

### Filter syntax note (B5)

Trade Show proposed `context.eventId` / `context.externalUserId`.  
**Midas publishes** (equivalent, indexed):

```
GET /api/v1/ext/expenses?sourceApp=trade_show&eventId=<uuid>&externalUserId=<uuid>
```

Stored in `expenses.source_context` jsonb (`eventId`, …) and denormalized `expenses.external_user_id` for the user filter. No Trade Show–specific column named `event_id`.

### Path alias note (B3)

`GET /api/v1/ext/expenses/by-ref?sourceApp=&sourceRefId=` is **Required** (not optional) for BFF redirects by legacy id.

---

## 3. A–K accepted

| # | Value |
|---|---|
| A | `sourceApp=trade_show` |
| B | `sourceRefId` = TS `expenses.id` UUID; event in `sourceContext.eventId` |
| C | Server BFF only — Bearer app key + actor headers; browser never holds key |
| D | `MIDAS_MODE` / `EXPENSE_BACKEND`; dual ≤ 1–2 weeks ops-agreed then midas |
| F | Exact category name match; OCR map via `category_mappings`; else Other + warning |
| G | Status map incl. `needs further review` → `awaiting_info`; reimbursement map incl. `rejected` |
| H | Remove local OCR/Zoho/accountant SoT + Daily Expenses; keep Expenses UX fed by BFF |
| I | Offline = TS client → BFF → Midas sync APIs |
| J | Cutover unset; propose ≤ 2h write-freeze at prod flip |
| K | Events/users/etc. stay in TS; expenses table non-SoT after cutover |

---

## 4. Checklist C1–C13

| ID | Midas | Trade Show | Notes |
|---|---|---|---|
| C1–C12 | AGREED | AGREED | Per TS response §4 + countersign |
| C13 | **OPEN** | COMPLETE mirrored | Ext sandbox implementation authorized |

---

## 5. Category artifact (accepted)

Seed exact names + OCR suggestion map from Trade Show alignment response §3 — copied into `EXT_API_MERGE_LOCK.md` for implementers.

---

## 6. Phase 0 ops (next, not coding)

1. Trade Show sets alignment status → **COMPLETE**.  
2. Midas (ops): create sandbox `app_connections` row `trade_show` with scopes:  
   `expenses:create`, `expenses:read`, `expenses:update`, `expenses:delete`,  
   `receipts:create`, `expenses:import`, `ocr:process`.  
3. Seed categories + initial `category_mappings` for `sourceApp=trade_show`.  
4. Midas implements Ext per `EXT_API_MERGE_LOCK.md` on sandbox.  
5. Trade Show sandbox branch only — production TS unchanged until Phase 4/5 approval.

---

## 7. Alignment log

| When | Who | Note |
|---|---|---|
| 2026-08-03 | Trade Show | Coding frozen; merge contract published |
| 2026-08-03 | Midas | Alignment v0.1 NOT ALIGNED; asked B1–B12 / A–K |
| 2026-08-03 | Trade Show | Published alignment response; C13 CLOSED pending countersign |
| 2026-08-03 | Midas | **Countersigned B1–B12; state → ALIGNED**; scopes now required; DELETE/B8 refined; appendix = `EXT_API_MERGE_LOCK.md` |
| 2026-08-03 | Trade Show | COMPLETE mirrored; D1 `sourceContext` ACK’d; proceed Ext sandbox |
| 2026-08-03 | Midas | Dual-app **COMPLETE**; C13 **OPEN** |
| 2026-08-03 | Midas | Ext Required surface complete; local smoke green; `TRADE_SHOW_AGENT_HANDOVER.md` published |

---

## 8. Document control

| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-08-03 | Midas | Initial blockers |
| 0.2 | 2026-08-03 | Midas | Absorbed merge contract (pre-response) |
| 0.3 | 2026-08-03 | Midas | Countersign TS alignment response; **ALIGNED** |
| 0.4 | 2026-08-03 | Midas | TS COMPLETE mirror + D1 ACK; dual-app **COMPLETE**; coding gate OPEN |
