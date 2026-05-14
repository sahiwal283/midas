# Midas Database Design

Schema file: `apps/api/src/db/schema.ts`  
ORM: Drizzle ORM 0.38 + drizzle-kit  
Database: PostgreSQL 15 on CT 3220 (192.168.1.211)

---

## Tables and Purpose

| Table | Purpose |
|---|---|
| `users` | All user accounts. Covers local-auth (pre-SSO) and will eventually map to Authentik subjects. |
| `expense_categories` | Category taxonomy managed by admins. Seeded with 10 defaults. |
| `payment_methods` | Company-wide and user-assigned payment cards/accounts. Carries `zoho_account_name` for Zoho mapping. |
| `expenses` | Core expense records. Owns review status, reimbursement status, Zoho sync state, source link, and foreign keys to user/category/payment method. |
| `receipts` | File attachments per expense. Carries OCR state (`pending` → `processing` → `done`/`failed`) and raw OCR output. Cascade-deleted with expense. |
| `expense_messages` | In-app conversation thread per expense. Owned by Midas; Telegram is notify-only. Contains both user/accountant messages and accountant info-requests (with `request_type`, `internal_note`, `is_resolved`). |
| `captures` | Browser extension screenshots. May pre-date an expense (`expense_id` nullable). Linked to expense on submission. |
| `audit_logs` | Immutable append-only event log. Records status transitions, admin actions, Zoho pushes, and review operations with before/after snapshots. |
| `app_connections` | API key registry for app-to-app integration (Argo, etc.). Keys are SHA-256 hashed; `permissions` is a JSON string array. |

---

## Enum Definitions

```
user_role:             user | accountant | admin
expense_status:        draft | pending | in_review | awaiting_info |
                       approved | zoho_sync_failed | rejected
reimbursement_status:  not_requested | pending | approved | paid
ocr_status:            pending | processing | done | failed
capture_source:        extension | manual
capture_status:        draft | linked | discarded
```

---

## Foreign Keys and Cascade Rules

| FK | On Delete | Rationale |
|---|---|---|
| `expenses.user_id → users.id` | RESTRICT | Cannot delete a user who owns expenses |
| `expenses.category_id → expense_categories.id` | SET NULL | Expense survives category removal |
| `expenses.payment_method_id → payment_methods.id` | SET NULL | Expense survives payment method removal |
| `expenses.reviewed_by_id → users.id` | SET NULL | Reviewership clears if accountant deleted |
| `receipts.expense_id → expenses.id` | CASCADE | Receipts belong entirely to their expense |
| `expense_messages.expense_id → expenses.id` | CASCADE | Thread belongs entirely to expense |
| `expense_messages.sender_id → users.id` | RESTRICT | Cannot delete a user who sent messages |
| `expense_messages.resolved_by_id → users.id` | SET NULL | Resolution record survives user deletion |
| `captures.user_id → users.id` | RESTRICT | Captures belong to their creator |
| `captures.expense_id → expenses.id` | SET NULL | Capture survives expense deletion |
| `audit_logs.user_id → users.id` | SET NULL | Audit trail preserved even if actor deleted |
| `payment_methods.assigned_user_id → users.id` | SET NULL | Card survives user deletion |

---

## Indexes (as of 2026-05-13)

All indexes are non-unique unless noted.

```
expenses_user_id_idx        expenses(user_id)               — user's expense list
expenses_status_idx         expenses(status)                — accountant queue filter
expenses_reviewed_by_idx    expenses(reviewed_by_id)        — claim queries
expenses_created_at_idx     expenses(created_at)            — default sort order
expenses_source_unique_idx  UNIQUE expenses(source_app, source_ref_id)
                                                            — prevents duplicate imports;
                                                              Postgres NULL semantics allow
                                                              multiple manually-submitted rows
receipts_expense_id_idx     receipts(expense_id)
expense_messages_expense_id_idx  expense_messages(expense_id)
audit_logs_entity_idx       audit_logs(entity_type, entity_id)  — audit trail query
audit_logs_created_at_idx   audit_logs(created_at)
captures_user_id_idx        captures(user_id)
captures_expense_id_idx     captures(expense_id)
```

Primary keys (UUIDs) and unique columns (`users.email`, `expense_categories.name`,
`app_connections.app_name`) are automatically indexed by Postgres.

---

## Source Link Fields

The `expenses` table carries four source-link columns designed for integration with
external apps (primarily Argo) without coupling Midas to any specific app:

| Column | Purpose |
|---|---|
| `source_app` | Identifier of the originating app: `'argo'`, `'trade_show'`, `null` for native |
| `source_ref_id` | ID of the record in the source app |
| `source_type` | Submission context: `'online_receipt'`, `'manual'`, or `null` |
| `source_label` | Human-readable context label (e.g. `"Expo West 2026 — Booth 42"`) |
| `source_url` | Deep-link URL back to the source record in the originating app |

`source_app` and `source_ref_id` are paired — both null means the expense was submitted
directly in Midas. A unique index (`expenses_source_unique_idx`) prevents duplicate
imports from the same external source.

---

## Zoho Sync Fields

| Column | Purpose |
|---|---|
| `zoho_entity` | Zoho organization/book identifier (currently free text; needs structuring before real integration) |
| `zoho_expense_id` | Zoho expense ID returned after successful push |
| `zoho_synced_at` | Timestamp of last successful Zoho sync |
| `zoho_sync_error` | Error message from the last failed Zoho push |

`expenses.status = 'zoho_sync_failed'` is set alongside `zoho_sync_error`. Note that
Zoho sync state currently bleeds into the main review status enum — see Known Issues.

---

## Accounting Workflow Separation

The schema separates concerns cleanly at the column level:

| Concern | Column(s) |
|---|---|
| Review workflow | `expenses.status` (draft → pending → in_review → awaiting_info → approved/rejected) |
| Reimbursement | `expenses.reimbursement_status` (independent of review) |
| Zoho sync | `zoho_entity`, `zoho_expense_id`, `zoho_synced_at`, `zoho_sync_error` |
| Payment | `expenses.payment_method_id` → `payment_methods` |
| Accounting entity | `payment_methods.zoho_account_name` (maps card to Zoho account) |
| Category | `expenses.category_id` → `expense_categories` |
| Evidence | `receipts` (with OCR state) |
| Communication | `expense_messages` (in-app thread, owns info-requests) |
| Reviewer | `expenses.reviewed_by_id`, `expenses.reviewed_at` |
| Audit trail | `audit_logs` (append-only, entity/action/before/after) |
| Source context | `source_app`, `source_ref_id`, `source_label`, `source_url` |

---

## Known Issues and Pre-Production Fixes Needed

### Before real Zoho integration

**Z-1** `expenses.zoho_entity` is a single free-text field. Real Zoho integration requires
at minimum a Zoho organization ID plus entity type (expense claim vs. petty cash, etc.).
Recommendation: add `zoho_org_id text` and convert `zoho_entity` to a structured type
when wiring real Zoho. Do not pre-add fields until the Zoho service contract is known.

**Z-2** `expenses.status` includes `zoho_sync_failed`. This means a failed Zoho push
overrides the review status (e.g. an approved expense shows as `zoho_sync_failed`).
Recommendation: add `zoho_sync_status enum('idle', 'pending', 'synced', 'failed')` as a
separate column. Defer until Zoho integration begins.

### Before data migration

**M-1** `expense_messages.request_type` is free text. Values (`'info_request'`,
`'missing_receipt'`, etc.) are only enforced by application code. Risk: divergent values
across migration data. Recommendation: convert to a PostgreSQL enum before migrating
historical data.

**M-2** `receipts.uploaded_at` uses a non-standard column name. All other tables use
`created_at`. Recommendation: rename to `created_at` in the migration schema.
Risk: requires data migration (ALTER TABLE RENAME COLUMN).

### Ongoing / low-priority

**L-1** No `updatedAt` database trigger. Application code must set `updated_at = NOW()`
on every update. Risk: routes that forget will leave stale timestamps. A trigger would
make this automatic and reliable.

**L-2** `expense_categories` has no `updated_at` column. Minor inconsistency.

**L-3** `app_connections` has no `updated_at` column. Minor inconsistency.

**L-4** No `users.last_login_at` column. Useful for security monitoring and identifying
inactive accounts. Low priority for pilot.

---

## `updatedAt` Application Contract

Until a database trigger is added, every UPDATE route must explicitly include:

```typescript
await db.update(expenses)
  .set({ ..., updatedAt: new Date() })
  .where(eq(expenses.id, id));
```

This contract must be maintained across all route handlers. An audit of all UPDATE
statements should happen before production.
