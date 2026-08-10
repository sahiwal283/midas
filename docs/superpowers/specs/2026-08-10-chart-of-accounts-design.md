# Chart of Accounts Settings Page

**Date:** 2026-08-10 · **Status:** Approved
**Goal:** Give accountants a settings page to link each Midas expense category to an account from a chosen company's live Zoho Books chart of accounts. Also make the category tree collapsible wherever it renders in Settings.

## Scope

In scope: the Chart of Accounts page, its three admin API routes, and collapsible category trees in Settings.
**Explicitly dropped by the user (2026-08-10): the Roles CRUD page.** `users.role` remains the fixed `user_role` enum; no auth-layer changes.

## Access

Section is added to the Settings "Expenses" nav group, so it is visible to `accountant` and `admin`; `developer` passes every gate via `roleAllowed`. Regular users and partners never see it. API routes use the existing `accounting = requireRole('accountant', 'admin')` gate in `admin.ts`.

## Storage

Reuses the existing `category_zoho_accounts` table (category_id × company_name → zoho_account_id, unique on the pair). No schema change.

## Page behavior

1. **Company selector** — Zoho-enabled companies only (`companies.zohoEnabled = true`); Zoho-disabled companies (e.g. Summitt Labs) are excluded with an explanatory note.
2. On company selection, the page loads in parallel: the live Zoho chart of accounts (`GET /zoho/expense-accounts?zohoEntity=<company>`) and the saved mappings for that company.
3. **Category tree** renders indented and collapsible; each row has a `<select>` of that company's Zoho expense accounts.
4. Selecting an account upserts immediately; a "Clear" action deletes the mapping.
5. **Inheritance display**: a category with no mapping of its own shows the account it inherits, greyed out, naming the ancestor it comes from ("inherited from Travel"). Each row shows a mapped / inherited / unmapped state.
6. **Zoho unreachable**: saved mappings still render (read-only selects) with an error banner; the page never blanks out.

## API (all behind `accounting`)

- `GET /admin/category-zoho-accounts?companyName=X` → `{ mappings: { categoryId, companyName, zohoAccountId }[] }`
- `PUT /admin/category-zoho-accounts` body `{ categoryId, companyName, zohoAccountId }` → upsert on the `(category_id, company_name)` unique index → `{ mapping }`
- `DELETE /admin/category-zoho-accounts?categoryId=&companyName=` → `{ ok: true }`

Live account listing reuses `GET /zoho/expense-accounts` unchanged. All three routes write an audit log entry.

## Collapsible category tree

A shared `useCollapsibleTree` hook (web) tracks collapsed ids and derives visible rows from `flattenTree` output. Applied to both the Categories tab and the Chart of Accounts page. Default: top-level categories expanded-visible, their children collapsed. Expand-all / collapse-all controls; a collapsed parent shows its descendant count.

## Out of scope

- Roles CRUD (dropped).
- Changing Zoho resolution order (live per-expense pick → per-entity table walking ancestry → legacy column walking ancestry → null) — unchanged.
- Payment-method (paid-through) account mapping.
- Writing to Zoho Books.
