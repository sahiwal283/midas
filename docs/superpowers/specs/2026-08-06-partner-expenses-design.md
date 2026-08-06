# Partner Expense Tracker — Design

**Date:** 2026-08-06
**Status:** Approved

## Purpose

A standalone expense tracker for partner-related expenses, visible only to users with the
`partner` role (and `developer`, which has access to everything). Completely separate from
the normal expense flow: no receipts, no accountant queue, no reimbursement, no Zoho.

## Roles

- Add `partner` and `developer` to the `user_role` Postgres enum and the shared `UserRole`
  type in `packages/shared`.
- **Developer is all-access, enforced at the gates — not per-route:**
  - API: `requireRole(...)` in `apps/api/src/middleware/auth.ts` passes automatically when
    `req.user.role === 'developer'`.
  - Web: `ProtectedRoute` passes automatically when `user.role === 'developer'`.
  - Sidebar: `isPrivileged` / `isAdmin` checks treat `developer` as true, so developers see
    every nav item.
- `db:seed` adds test users: `partner@midas.local` / `partner123` and
  `developer@midas.local` / `developer123`.

## Data model

New table `partner_expenses` (Drizzle schema + generated migration):

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | `gen_random_uuid()` |
| `user_id` | uuid FK → `users.id` | who logged it |
| `amount` | numeric(12,2) | same convention as `expenses.amount` |
| `item_location` | text | free-text item/location |
| `category` | enum `partner_expense_category` (`business` \| `personal`) | default `business` |
| `created_at` | timestamptz | default now |

## API

New router `apps/api/src/routes/partnerExpenses.ts`, mounted at `/api/v1/partner-expenses`,
gated with `requireRole('partner')` (developer passes via the middleware rule):

- `GET /` — all partner expenses (shared view across all partners), joined with the user's
  name, newest first.
- `POST /` — create with `{ amount, itemLocation, category? }`. Category defaults to
  `business`. Validation lives in `apps/api/src/lib/partnerExpenses.ts`. Writes an
  `audit_logs` entry.

No edit/delete/approval in v1.

## Web

- Sidebar link **Partner Expenses** → `/partner-expenses`, visible to `partner` and
  `developer`.
- Route wrapped in `ProtectedRoute roles={['partner', 'developer']}`.
- One page `apps/web/src/pages/PartnerExpenses.tsx`, table styled like My Expenses
  (`ExpenseList.tsx`): columns **User · Amount · Item/Location · Category**, category
  rendered as a small business/personal badge.
- Intake: a "New Partner Expense" button on the same page opens a compact form —
  amount, item/location, Business/Personal toggle defaulting to **Business**.

## Testing

Vitest unit tests (no DB), following the existing `apps/api/src/__tests__` pattern:

- `partnerExpenses.test.ts` — input validation/normalization: business default, amount
  validation, required item/location.
- Role-gate behavior: `requireRole` passes `developer` for any role list.

## Out of scope

Receipts, OCR, Zoho push, reimbursement, editing/deleting entries, per-partner privacy
(all partners see all partner expenses), pagination/filtering (table is small for v1).
