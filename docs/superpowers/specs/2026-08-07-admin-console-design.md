# Admin Console — Design

**Date:** 2026-08-07
**Status:** Approved (roadmap sub-project E)

## User org fields (migration 0011)

`users` gains nullable columns: `department text`, `employee_id text`,
`cost_center text`, `manager_id uuid REFERENCES users(id) ON DELETE SET NULL`,
`default_zoho_entity text` (default company), `default_payment_method_id uuid
REFERENCES payment_methods(id) ON DELETE SET NULL`, `last_login_at timestamp`,
`invite_token text`, `invite_expires_at timestamp`.

- `last_login_at` set on every successful local login and OIDC callback.
- Admin PATCH `/admin/users/:id` accepts the new profile fields (role guards
  unchanged). GET `/admin/users` returns them + lastLoginAt.
- The wizard uses `default_zoho_entity`/`default_payment_method_id` as initial
  form values when set (card default still wins for company when a card is
  picked). (`GET /auth/me` exposes the two defaults.)

## Invitations (email lands with sub-project F; links work today)

- `POST /admin/users/invite` `{ name, email, role, ...profile fields }` —
  creates an active user with NO password + a 7-day single-use
  `invite_token`; returns `{ user, inviteUrl }` (`{MIDAS_URL}/invite/{token}`).
- `POST /admin/users/:id/invite/resend` — regenerates token/expiry, returns
  the new url (works for any user with no password who isn't SSO-linked).
- Public: `GET /auth/invite/:token` → `{ valid, name, email }`;
  `POST /auth/invite/:token` `{ password (min 8) }` → sets hash, clears token,
  logs the user in (same cookie as login). Web page `/invite/:token` (outside
  ProtectedRoute) with a set-password form.
- Admin UI shows "Invited — link copied" flows (copy button); "resend
  invitation" per user.

## Audit log UI

`GET /admin/audit` with `entityType`, `action` (prefix match), `userId`,
`entityId`, `from`, `to`, `search` (action/entityType ILIKE), `page`/`pageSize`
(≤100, default 50) → `{ entries, total, page, pageSize }` with actor name
joined. New Admin section "Audit Log" with filter bar + paged table
(timestamp, actor, action, entity, before/after expandable JSON).

## Payment method assignment

Policy: a card is either **company-wide** (everyone sees it) or **assigned**
to exactly one user (`assigned_user_id` — supports employees holding multiple
corporate cards; multi-user cards stay company-wide). PaymentMethods page gets
per-card editing: label, last four, Zoho paid-through, default company,
requires-reimbursement, and an Assignment control (Company-wide ⇄ Assigned to
{user select}). `GET /payment-methods` already scopes non-privileged users to
company-wide; extend it to ALSO include cards assigned to the caller.

## Admin IA reorg + modal polish

Admin page tabs regrouped with section headers (still one page):
**Company** (Companies) · **People** (Users) · **Expenses** (Categories,
Payment Methods link) · **Integrations** (Connections) · **Security**
(Audit Log). Replace `alert()`/`window.confirm()` in Admin + PaymentMethods
with a shared `ConfirmModal`/inline error panels; the destructive user-delete
modal shows the owned-data counts (from the existing 409 payload) with
"Deactivate instead" as the preferred action and "Delete permanently" as the
dangerous one.

## Bulk user operations

Multi-select in the Users table → bulk Deactivate / Reactivate
(`POST /admin/users/bulk` `{ ids ≤200, action: 'deactivate' | 'reactivate' }`,
self excluded server-side, per-item results). Bulk delete intentionally NOT
offered (per-user modal only).

## Testing

Vitest: invite token issue/validate/consume decision lib (`lib/invites.ts` —
expiry + single-use), audit filter parsing (reuse pattern). Web tsc + visual.

## Out of scope

Email delivery (F), approval rules/manager approval chains, SSO-only
enforcement toggle, departments/cost centers as managed lists (free text v1).
