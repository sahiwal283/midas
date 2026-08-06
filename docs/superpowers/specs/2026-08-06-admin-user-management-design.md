# Admin User Delete + Role Management — Design

**Date:** 2026-08-06
**Status:** Approved

## Purpose

Admin Settings → Users currently only deactivates users and cannot change roles. Add:
hard delete (with an explicit purge mode for users who own data) and role assignment
across all five roles.

## Role changes

- `POST /admin/users` and `PATCH /admin/users/:id` role enums become
  `['user', 'accountant', 'admin', 'partner', 'developer']`.
- Guards (API, in `PATCH`):
  - An admin cannot change their own role (`SELF_ROLE_CHANGE`, 400).
  - Cannot demote the last active admin (`LAST_ADMIN`, 400). "Active admin" =
    `role='admin' AND is_active=true`. (Developers are not counted — admin is the
    canonical management role.)
- Web: the role cell in the Users table becomes a `<select>` that PATCHes on change,
  disabled on the admin's own row. The New User form's role select gains the two new
  roles.

## Delete

New `DELETE /api/v1/admin/users/:id` (admin-gated like the rest of the router).
Query param `purge=true` enables purge mode.

**Guards (both modes):**
- No self-delete (`SELF_DELETE`, 400).
- No deleting the last active admin (`LAST_ADMIN`, 400).
- 404 if user not found.

**Safe delete (default):** count the target's owned rows — expenses, receipts (via
their expenses), expense messages sent (any expense), captures, partner expenses.
If all zero → delete the user row (`sso_links` cascades, `audit_logs.user_id` and
`payment_methods.assigned_user_id` null out). If any nonzero → `409 HAS_DATA` with
`{ counts: { expenses, receipts, messages, captures, partnerExpenses } }`.

**Purge (`?purge=true`):**
- If any of the user's expenses has `zoho_expense_id` → `409 ZOHO_LINKED` with the
  count; nothing is deleted. Those are in the books — handle deliberately first.
- Otherwise delete, in order: the user's expenses via the existing `expenseDelete`
  helpers (removes receipts + stored files + messages + capture links per expense),
  the user's sent messages on other users' expenses, their captures, their partner
  expenses, then the user row.
- Audit log `admin.user.deleted` (or `admin.user.purged`) with the deleted counts in
  `metadata`. Audit rows referencing the user keep their data; `user_id` nulls.

## Web UI

- Red **Delete** button next to Deactivate/Reactivate (hidden on own row).
- Click → `window.confirm("Delete <name>? This cannot be undone.")` → `DELETE`.
- On `409 HAS_DATA` → second `window.confirm` listing the counts and offering
  "Delete user AND all their data" → `DELETE ?purge=true`.
- On `409 ZOHO_LINKED` / `400 LAST_ADMIN` / etc. → `alert()` with the API message.
- Role `<select>` per row as above; changes apply immediately and refresh the list.

## Testing

`apps/api/src/lib/userDelete.ts` holds the pure decision logic, Vitest-covered
(no DB): self-delete guard, last-admin guard (delete and demote variants),
has-data → 409 decision, Zoho-linked → purge refusal.

## Out of scope

Deleting users with Zoho-synced expenses (blocked by design), bulk delete,
undo/soft-delete trash, transferring data ownership, SSO-side (Authentik)
deprovisioning, deleting orphaned capture screenshot files for captures never
linked to an expense (rows are deleted; files remain on disk).
