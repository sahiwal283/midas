# Cashbook merge into Midas — design

Approved in chat 2026-08-21. Merges the standalone Cashbook app
(cashbook.booute.duckdns.org, CT 120 `/opt/cashbook`) into Midas as an
accountant-section page, then retires the standalone app.

## Context discovered

- Cashbook is Next.js with server actions — no REST API. It uses two databases:
  its own Postgres (`cashbook-db` on CT 120) for regular businesses, and the
  payroll app's Postgres **directly** (raw SQL) for the payroll-linked
  "Boomin/Haute" drawer.
- Payroll-linked writes serialize on advisory lock `48230011` — the same lock
  the payroll app takes — so a drawer withdrawal and a payroll run cannot
  jointly overdraft. Every mutation writes a payroll `audit_log` row in the
  same transaction. Withdrawals recorded by payroll runs (`period_id` set) are
  read-only in the drawer UI.
- Money is integer cents. Ledgers are append-only: entries void, never delete.
  Deposits require an invoice number. Petty-cash purchases are withdrawals
  with `category = 'PETTY_CASH'` and an optional receipt file.
- The payroll `cash_drawer_entries` table has **no entry_date column** —
  payroll-linked entries cannot be backdated; local drawer entries can
  (entry_date defaults today, never future).
- Data to migrate: businesses (Nirvana Kulture — 52 entries; Boomin/Haute —
  payroll-linked, 0 local rows). No receipt files exist in either database.
- The payroll DB already has a `cashbook` role for cross-app access; Midas
  reuses it. `payroll-db` publishes no port — deploy step publishes 5432 on
  CT 120's LAN IP (192.168.1.197) for Midas.

## Decisions

1. **End state**: retire the cashbook app. Nirvana's ledger migrates into
   Midas Postgres; Boomin/Haute's ledger stays in the payroll DB with Midas
   reading/writing it directly (payroll remains the source of truth).
2. **Access**: role-gated — accountant/admin/developer see every business.
   The per-business membership model is dropped.
3. **Businesses stay their own concept** (not Midas companies): the payroll
   drawer spans Boomin + Haute. New businesses can be created from the page.

## Architecture

- **Schema (migration 0027)**: `cash_businesses` (name unique, payroll_linked,
  archived_at) and `cash_drawer_entries` (kind DEPOSIT/WITHDRAWAL, amount_cents
  bigint > 0, invoice_number, notes, category, receipt_path, entry_date,
  created_by_id → users set-null, voided_at/voided_by_id). Local mutations
  write Midas `audit_logs`.
- **`lib/cashLedger.ts`**: pure helpers ported from cashbook's `lib/cash/ledger.ts`
  (amount/date/deposit/petty-cash validation, balance, CSV) with unit tests.
- **`lib/payrollDrawer.ts`**: pg Pool on `PAYROLL_DATABASE_URL` (unset = payroll
  drawer unavailable; local businesses unaffected). Ports cashbook's SQL:
  balance, list (join pay_periods + users for period range and author email),
  deposit, withdrawal (advisory lock + balance check), petty cash, void
  (blocks period-linked rows; deposit void cannot go negative). Actor columns
  are null (Midas users aren't payroll users); audit rows tag
  `user_agent = 'midas'` and record the Midas actor in `after`.
- **`routes/cashbook.ts`** at `/api/v1/cashbook`, accountant-gated:
  - `GET /businesses` — with on-hand / lifetime totals
  - `POST /businesses` — create (admin+accountant)
  - `GET /businesses/:id/ledger` — entries newest-first
  - `POST /businesses/:id/deposit|petty-cash|withdrawal` (petty-cash is
    multipart; receipt stored via the storage adapter)
  - `POST /businesses/:id/entries/:entryId/void`
  - `GET /businesses/:id/export.csv`
  - `GET /businesses/:id/receipts/:entryId` — streams the receipt file
  For the payroll-linked business these dispatch to `payrollDrawer`.
- **Web**: `pages/Cashbook.tsx` at `/cashbook`, Accountant nav (Wallet icon).
  Business pill switcher (URL-backed), LINKED TO PAYROLL badge, three summary
  cards, three action cards (date fields only on non-payroll businesses),
  Midas-style ledger table + mobile cards, void with confirm, Export CSV,
  payroll-run rows link to the payroll app.
- **Migration script** `apps/api/scripts/migrate-cashbook.ts`: copies
  businesses + entries from cashbook-db (authors mapped by email to Midas
  users; unmatched author emails preserved in a "recorded by" suffix in
  metadata), verifies migrated balance equals the source balance.

## Rollout

1. Deploy Midas with the module (payroll drawer needs `PAYROLL_DATABASE_URL`).
2. Publish payroll-db 5432 on CT 120 LAN; add env; restart Midas api.
3. Run migration; verify Nirvana on-hand ($96,496.00) and Boomin/Haute
   on-hand ($15,388.00) match the live cashbook site.
4. User retires the cashbook site when satisfied.
