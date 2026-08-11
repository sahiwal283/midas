# Partner Expenses — Fold Into the Regular Expense Flow

**Date:** 2026-08-11 · **Status:** Approved
**Goal:** Partner-role users mark an expense as business or partner while submitting it through the normal flow. The Partner Expenses tab becomes a reporting view — table plus charts — over real expenses instead of a standalone mini-tracker.

## Why the current build is wrong

`partner_expenses` is a separate table with its own create form capturing only `amount`, `item_location` and `category (business|personal)`. It has no date, merchant, receipt, expense category or payment method, and no connection to the expense pipeline. It is a second, weaker way to record spending.

It currently holds **0 rows**, so there is nothing to migrate.

## Decisions (user-confirmed)

| Question | Decision |
|---|---|
| Review queue / Zoho | **Excluded** — partner expenses never enter review or push to Zoho |
| "Individual" in charts | **Per person** (who submitted) |
| Visibility | **All partners' expenses**, as today |
| Old `partner_expenses` table + form | **Dropped** |
| Who sees the business/partner choice | **Partner role only** (developer passes every gate) |

## Design

### 1. Marker — migration 0023
`expenses.expense_kind`, Postgres enum `('business','partner')`, `NOT NULL DEFAULT 'business'`. Existing rows backfill via the default. An enum rather than a boolean so a third kind stays possible and queries read clearly.

Dropped in the same migration: `partner_expenses` table, `partner_expense_category` enum, `/api/v1/partner-expenses` routes, the web API client, and the standalone create form.

### 2. Expense form
Partner-role users see a two-option toggle — **Business expense / Partner expense** — defaulting to Business. The field is hidden for every other role, and the API coerces `expense_kind` to `'business'` when the submitter is not a partner, so the value is never trusted from the client.

### 3. Pipeline exclusion
- Accountant queue and Zoho-eligible queries filter `expense_kind = 'business'`.
- `pushExpenseToZoho` refuses a partner expense with an explicit reason rather than skipping silently.

Partner expenses keep everything the standalone tracker lacked: receipts, OCR, expense categories, payment methods, and company.

### 4. Partner Expenses tab
Scope: all partner-kind expenses, visible to partner, admin, accountant and developer (unchanged from today's route gate).

- **Table** — date, submitter, merchant, category, payment method, amount. Replaces the amount + item/location row.
- **Charts**, reusing the Reports page's Recharts setup and the dataviz palette:
  - Spend **by category** — donut
  - Spend **by month** — bar
  - Spend **by individual** — horizontal bar (person names are long; horizontal keeps labels legible)
- A date-range filter drives the table and all three charts, matching Reports.

New endpoint `GET /api/v1/partner-expenses/summary?from=&to=` returns the three aggregations server-side, mirroring `/reports/summary`'s response shape so the page stays cheap as volume grows.

## Out of scope
- Any change to how business expenses behave.
- Partner-specific budgets or approval rules.
- Per-merchant breakdown (per person was chosen).
- Backfilling historical expenses as partner expenses — every existing row is business.
