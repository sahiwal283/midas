# Transaction + Purchase Order Foundation — Design

**Date:** 2026-08-10  
**Status:** Approved for Phase 1 implementation  
**Scope:** P0 domain model, Zoho PO adapter (mirror expenses), soft-cancel, integration status split

## Goal

Replace the expense-only root with a shared **transaction** model so expenses and purchase orders share receipts, OCR, audit, comments, approval, and Zoho sync — without bolting PO fields onto `expenses`.

## Domain model

```
transactions (root)
├── type: expense | purchase_order
├── status: draft | submitted | in_review | awaiting_info | approved | rejected | cancelled
├── integration_status: not_required | pending | queued | syncing | synced | failed
├── expense_details (1:1 when type=expense)
├── purchase_orders (1:1 when type=purchase_order)
└── transaction_line_items (0..n; required for POs)
```

### Status split

| Concern | Field | Notes |
|---------|-------|-------|
| Workflow | `status` | No `zoho_sync_failed` — that moves to integration |
| Zoho | `integrationStatus` | Approval ≠ synced |
| Reimbursement | `expense_details.reimbursementStatus` | Expense only |
| OCR | `receipts.ocrStatus` | Unchanged |

Migration mapping from legacy `expense_status`:

| Old | New status | New integrationStatus |
|-----|------------|----------------------|
| draft | draft | not_required (or pending if company zoho-enabled later) |
| pending | submitted | pending if zoho entity set else not_required |
| in_review | in_review | pending |
| awaiting_info | awaiting_info | pending |
| approved | approved | synced if zohoExpenseId else pending |
| zoho_sync_failed | approved | failed |
| rejected | rejected | not_required |

### Soft-cancel

After `submitted` (and always when `integrationStatus=synced`): prefer `cancelled` over DELETE. Admin force-delete remains for never-synced drafts only.

### ID stability

Migrated expense rows keep the same UUID as `transactions.id` so EXT API and deep links stay valid.

## Zoho PO contract (Midas → Integration Service)

Same auth as expenses: `Authorization: Bearer <ZOHO_SERVICE_TOKEN>`, `X-Brand`, `ZOHO_MODE` / `ZOHO_DRY_RUN`.

See [`docs/ZOHO_PO_CONTRACT.md`](../../ZOHO_PO_CONTRACT.md).

## EXT API

Trade Show continues to call `/api/v1/ext/expenses*`. Handlers read/write `transactions` where `type=expense` and map response shapes unchanged per `EXT_API_MERGE_LOCK.md`.

## Out of scope (Phase 2+)

Full OCR confirmation UX, branding redesign, budgets, server-paginated accountant queue (filter by type only in Phase 1), live Zoho PO writes until the integration service ships PO endpoints.
