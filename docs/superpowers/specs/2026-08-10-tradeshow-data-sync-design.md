# Trade Show → Midas Data Reconciliation

**Date:** 2026-08-10 · **Status:** Approved
**Goal:** Fix the incomplete early migration from the Trade Show app: correct user names/roles, import missing users and expenses, and copy Trade Show's per-entity category → Zoho account IDs into Midas. Trade show is authoritative; it is never written to.

## Context (measured 2026-08-10 against both production DBs)

- Trade show prod DB: CT 2320, `expense_app_production` (192.168.1.152). Midas prod DB: CT 3220, `midas` (192.168.1.211). Access via `ssh root@192.168.1.190` + `pct exec`.
- **Users:** 11 in trade show; 8 exist in Midas (matched by email) with placeholder names (email local-part, e.g. `sales` instead of "Shruti Patel") and role `user`. 3 are absent: salesguru@summittlabs.com (BRETT  POMMERENCK, salesperson), zeeshanv@gmail.com (Zeeshan Vira, admin), doubledspecialtyfoodservices@gmail.com (Darla Davis, salesperson).
- **Expenses:** 377 trade show vs 374 Midas (`source_app='trade_show'`, keyed by `source_ref_id`). Missing: a $1.00 "test" expense (2026-05-19, tech@cooliohcandy.com), Southwest Airlines $305.80 (sales@nirvanakulture.com, approved), SAHARA Las Vegas $454.12 (nabeelvira@gmail.com, pending). 5 field mismatches are cases where Midas moved ahead post-migration (3 zoho_entity set, 1 zoho_expense_id, 1 approval) — these stay.
- **Categories:** trade show `app_settings.categoryOptions` holds 15 categories, each with per-entity `zohoExpenseAccountIds` for `haute_brands` / `boomin_brands` / `nirvana_kulture`. Midas `expense_categories` has a single `zoho_account_id` column (Haute IDs, COA-verified 2026-08-03) that disagrees with trade show on 7 categories. Midas lacks "Stationaries" and "Storage charges"; its 9 extra categories are unused (0 expenses, 0 budgets).

## Decisions (user-confirmed)

| Question | Decision |
|---|---|
| Role mapping `salesperson` | → `user` |
| Role mapping `coordinator` | → `user` |
| 3 users absent from Midas | Create them |
| $1 test expense | Skip; import only Southwest + SAHARA |
| 5 post-migration mismatches | Keep Midas values |
| Per-entity Zoho IDs | New `category_zoho_accounts` table |
| 9 unused Midas-only categories | Leave as-is, active |
| Haute ID conflicts (7) | Import trade show's IDs, emit discrepancy report for accountant review |
| Dry run | Skipped — script prints each change as applied, single transaction |

## Design

### 1. Safety model
Trade show DB is read-only throughout: three JSON snapshots exported over SSH (users; `categoryOptions`; the 2 missing expenses joined with their event names). All writes happen on Midas inside one transaction — any failure rolls back everything. Every change is printed as applied and recorded via the existing `auditLog()` helper.

### 2. Schema (migration 0017)
New table `category_zoho_accounts`:

```
id uuid PK default gen_random_uuid()
category_id uuid NOT NULL FK → expense_categories(id) ON DELETE CASCADE
company_name text NOT NULL FK → companies(name) ON UPDATE CASCADE ON DELETE RESTRICT
zoho_account_id text NOT NULL
created_at timestamp NOT NULL default now()
UNIQUE (category_id, company_name)
```

Zoho push account resolution in `apps/api/src/lib/zohoPayload.ts` becomes:
1. per-expense live COA pick (`expense.zohoExpenseAccountId`) — unchanged, still wins
2. **new:** `category_zoho_accounts` lookup by (category, expense's `zoho_entity` company)
3. legacy `expense_categories.zoho_account_id` — untouched fallback
4. null

Entity slug → company name mapping: `haute_brands`→"Haute Brands", `boomin_brands`→"Boomin Brands", `nirvana_kulture`→"Nirvana Kulture".

### 3. Users
Matched by email.

- **8 existing:** overwrite `name` and `role` with trade show values verbatim (including "BRETT  POMMERENCK" casing/spacing). Role map: `developer→developer`, `admin→admin`, `salesperson→user`, `coordinator→user`. All other columns (password, `is_active`, defaults, timestamps) untouched — `tech@cooliohcandy.com` stays deactivated.
- **3 new:** insert with trade show name/email, mapped role, `password_hash` NULL (Authentik SSO or admin invite), `is_active` true.
- Midas-only users (`*@midas.local` seeds, sahilk@gmail.com) untouched.

### 4. Categories
- Insert missing categories **Stationaries** and **Storage charges** (active).
- Populate `category_zoho_accounts` from trade show's `categoryOptions` verbatim: one row per (category, entity) where an ID exists; nulls get no row. Exception: "Storage charges" values are polluted strings (`"Haute: 5254962000000000460"`, `"Boomin: 4849689000000000442"`) — store the extracted numeric ID, list raw values in the report.
- Legacy `zoho_account_id` column values are not modified.
- Script ends with the **Haute discrepancy report**: the 7 categories where trade show's Haute ID ≠ Midas's legacy ID, for accountant verification in Zoho Books.

### 5. Expenses
Insert the 2 missing expenses (Southwest, SAHARA) shaped identically to the 374 existing migrated rows: `source_app='trade_show'`, `source_ref_id`=trade show id (unique index `expenses_source_unique_idx` makes re-runs idempotent), `source_context` {eventId, eventName, cardUsed, location, submittedAt, externalUserId}, `external_user_id`, user by email, category by name, status mapped (`approved→approved`, `pending→pending`), reimbursement mapped as the originals were. If a trade show receipt file exists for either, copy it into Midas storage and create the `receipts` row, mirroring how the original migration represented receipts (verify against one existing migrated expense first). The $1 test expense is intentionally skipped.

### 6. Verification & rollout
1. Commit migration + resolution code + sync script; version bump; deploy API to prod.
2. Run sync script against CT 3220.
3. Re-run the comparison diff and assert: 11/11 users match trade show on email+name+mapped role; 376 `trade_show` expenses (377 − test) with zero field regressions; every non-null trade show Zoho ID present in `category_zoho_accounts`.

## Out of scope
- Any write to the trade show database.
- Reworking the 5 post-migration field differences.
- Deactivating/deleting the 9 unused Midas-only categories.
- Trade show roles `pending`/`temporary` (no users hold them).
