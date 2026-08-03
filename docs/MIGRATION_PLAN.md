# Midas Migration Plan

Migration of expense-related data from the existing trade-show app into Midas,
and separation of trade-show/event logistics data into Argo.

**Status:** Planning — no migration has been executed. Midas has no production data yet.  
**Target:** Midas becomes the expense system of record. Argo owns all trade-show/event context.

Midas now has a generic, reusable import pipeline (`@midas/import`) that can
execute the field mapping below — see `docs/IMPORT_FRAMEWORK.md` for how to
write an `ImportSource` for the trade-show app's data and run it via
`npm run import:run --workspace=@midas/api`. This document defines *what*
maps to *what*; that document defines *how* to run the import.

**Bilateral cutover contract:**  
`docs/CONTRACT_ALIGNMENT.md` — COMPLETE (Midas); coding after TS status mirror.  
`docs/EXT_API_MERGE_LOCK.md` — locked Ext API for implementation.  
`docs/TRADE_SHOW_MIGRATION_CONTRACT.md` — Midas cutover offer.

---

## Architectural Split

| System | Owns |
|---|---|
| **Midas** | Expenses, receipts, review workflow, reimbursement, Zoho sync, audit log, in-app communication |
| **Argo** | Trade show events, venues, booth assignments, attendees, exhibitor budgets, logistics |

Midas references Argo records via `source_app`, `source_ref_id`, `source_label`, `source_url` on the
`expenses` table. Midas never stores event-specific data as first-class fields.

---

## What Migrates into Midas

### Users

Map by email address. Create a local-auth account for each user who has expenses in the
trade-show app.

| Source | Midas field | Notes |
|---|---|---|
| Email | `users.email` | Unique key for matching |
| Name | `users.name` | |
| Role (if any) | `users.role` | Map to `user`/`accountant`/`admin` |

- Set `is_active = true` for all migrated users.
- Generate a temporary password via `reset-admin-pw.ts` equivalent. Users reset on first login.
- When Authentik SSO is wired, user records will be linked by email subject.

### Expense Categories

Match by name. If a category in the old app has a direct equivalent in Midas's seeded
categories, use the Midas category ID. If not, insert a new `expense_categories` record.

Do not delete existing Midas categories. New categories added during migration are
permanent.

### Payment Methods

Map company-wide cards by label. If a card in the old app matches a Midas payment method
by label or last four digits, use the existing record. Otherwise insert new records.

Set `zoho_account_name` on payment methods if the old app has Zoho account mappings.

### Expenses

Each trade-show expense becomes one `expenses` row.

| Source field | Midas field | Notes |
|---|---|---|
| Old expense ID | `source_ref_id` | |
| Source app name | `source_app` | e.g. `'trade_show'` or `'argo'` |
| Event name + context | `source_label` | e.g. `"Expo West 2026 — Booth 42"` |
| Argo deep link | `source_url` | URL to the event/expense in Argo |
| Submitting user | `user_id` | Match by email to Midas user |
| Category | `category_id` | Match by name |
| Payment method | `payment_method_id` | Match by label/last four |
| Merchant | `merchant` | |
| Amount | `amount` | |
| Currency | `currency` | Default `USD` if not set |
| Date | `date` | |
| Description | `description` | |
| Approval status | `status` | Map to Midas enum (see table below) |
| Reimbursement state | `reimbursement_status` | Map to Midas enum |
| Zoho expense ID (if any) | `zoho_expense_id` | |
| Reviewer (if any) | `reviewed_by_id` | Match by email to Midas user |
| Reviewed timestamp | `reviewed_at` | |

**Status mapping:**

| Old app status | Midas `status` |
|---|---|
| Draft / not submitted | `draft` |
| Submitted, not reviewed | `pending` |
| Under review | `in_review` |
| Approved | `approved` |
| Rejected | `rejected` |
| Awaiting info | `awaiting_info` |

**Reimbursement mapping:**

| Old app state | Midas `reimbursement_status` |
|---|---|
| Not requested | `not_requested` |
| Requested | `pending` |
| Approved for reimbursement | `approved` |
| Paid | `paid` |

### Receipts and Files

For each expense with a receipt file:

1. Copy the file to the Midas storage location (`uploads/` or S3 depending on `STORAGE_MODE`).
2. Insert a `receipts` row with `storage_path`, `filename`, `mime_type`, `size_bytes`.
3. Set `ocr_status = 'done'` if OCR text is available from the old system; otherwise `'pending'`.
4. Populate `ocr_text` if old OCR data exists.

### Audit / History

If the old app has an event log or status history:

1. Insert synthetic `audit_logs` rows with `action = 'expense.migrated'` and
   `metadata = { "migrated": true, "source_app": "trade_show", "original_status": "..." }`.
2. Set `entity_type = 'expense'`, `entity_id = <new Midas expense UUID>`.
3. Use `user_id = null` (or a dedicated migration service account) for migrated entries.

Do not fabricate fine-grained history that does not exist in the source. A single
migration event per expense is sufficient.

### App Connection (Argo)

Register Argo as an app connection in Midas by calling the admin API as an
authenticated admin user (there is no CLI wrapper for this today):

```bash
curl -X POST https://<midas-host>/api/v1/admin/connections \
  -H "Content-Type: application/json" \
  --cookie "token=<admin session cookie>" \
  -d '{"appName": "argo", "permissions": ["expenses:read", "expenses:create"]}'
```

The response includes the plaintext API key exactly once — store it securely
in Argo's own config. Argo then uses it (`Authorization: Bearer <key>`) to
post expenses via `/api/v1/ext/`. See `docs/EMBEDDING.md` for the full
app-to-app embedding contract.

---

## What Does NOT Migrate into Midas

The following data belongs in Argo and should not become Midas fields:

- Trade show event records (name, dates, venue, city, organizer)
- Booth assignments and floor plans
- Attendee and exhibitor lists
- Event budgets or per-event financial targets
- Shipping and logistics records
- Hotel block or group travel records
- Marketing campaign attribution

If Midas needs to display event context for an expense, it reads `source_label` and
`source_url` (already stored on the expense) and links back to Argo. It does not store
the event record.

---

## Pre-Migration Schema Fixes Required

These schema changes should be made and applied to CT 3220 before migration data is
inserted:

| Fix | Risk | Status |
|---|---|---|
| Add `expense_messages.request_type` enum | Migration — existing rows are `null` | Pending |
| Rename `receipts.uploaded_at` → `receipts.created_at` | Migration — requires ALTER TABLE | Pending |
| Add `expenses.source_label`, `source_url`, `zoho_sync_error` | Non-breaking (nullable) | Done ✓ |
| All indexes on `expenses`, `receipts`, `audit_logs`, etc. | Non-breaking | Done ✓ |
| Unique index on `(source_app, source_ref_id)` | Non-breaking (nulls allowed) | Done ✓ |

---

## Migration Execution Order

Run in exactly this order to respect foreign key constraints:

1. `expense_categories` — no dependencies
2. `users` — no dependencies
3. `payment_methods` — depends on `users` (for `assigned_user_id`)
4. `expenses` — depends on `users`, `expense_categories`, `payment_methods`
5. `receipts` + file storage — depends on `expenses`
6. `audit_logs` (synthetic migration events) — depends on `expenses`
7. `expense_messages` (historical, if any) — depends on `expenses`, `users`

---

## Duplicate-Prevention

The `expenses_source_unique_idx` unique index on `(source_app, source_ref_id)` prevents
re-running the migration from inserting duplicate expenses. The migration script should:

1. Use `INSERT ... ON CONFLICT (source_app, source_ref_id) DO NOTHING` for idempotency.
2. Log skipped rows for review.
3. Never update existing Midas expenses from source data on subsequent runs.

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Users exist in old app but not in Midas | Create Midas accounts before migrating expenses (migration order enforces this) |
| Category names differ between systems | Build a name-mapping table before migration; do not assume exact match |
| Payment method labels differ | Manual mapping pass before migration; allow null payment_method_id for unmapped cards |
| Old receipts in non-standard formats | Convert to supported MIME types before upload, or mark `ocr_status = 'failed'` |
| Old Zoho IDs present | Populate `zoho_expense_id`; mark `status = 'approved'` and `reimbursement_status = 'paid'` where appropriate |
| `expense_messages.request_type` free-text values differ | Normalize to known values before inserting, or leave null |
| Partial migration failure | Use database transactions per expense + its receipts/messages; roll back on error |

---

## What to Defer Until After Pilot

- Actual data migration (no real production expenses in Midas yet)
- Argo app connection setup (Argo not yet wired)
- `expense_messages.request_type` enum conversion (requires schema migration, not just push)
- `receipts.uploaded_at` rename (requires data migration)
- Zoho sync status separation from expense status enum

---

## Relationship to Authentik SSO

When Authentik SSO is wired:

1. Midas users will be matched to Authentik subjects by email.
2. `users.password_hash` will be unused for SSO users (keep the column; it won't be set).
3. The JWT will carry the Authentik subject ID instead of the Midas user ID as `sub`.
4. Migration-created users can be converted to SSO by matching email and clearing the password hash.

This does not change the migration plan — create local-auth accounts now, convert to SSO later.
