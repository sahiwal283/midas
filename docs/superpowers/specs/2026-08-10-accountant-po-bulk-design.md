# Accountant Polish + PO Bulk Parity — Design (Phase 7)

**Date:** 2026-08-10  
**Status:** Approved  
**Version target:** `0.26.0-alpha`  
**Roadmap:** Sub-project B finish (polish + PO parity). Phase 8 = C.

## Goal

Brand-align accountant surfaces and give purchase orders the same never-blind bulk approve / bulk Zoho push pattern expenses already have.

## Scope

### Brand polish
- `AccountantQueue`, `AccountantReview`, `PurchaseOrderQueue`, accountant Home → cream/ink/gold, Fraunces headers, `shadow-panel`. Behavior unchanged for expenses.

### PO bulk approve
- `POST /api/v1/transactions/bulk-review` `{ ids: string[] (≤200), action: 'approve' }`
- Approves only `submitted` | `in_review`; others skipped with reason.
- Mirrors single PO review (status, reviewedBy, integrationStatus, audit).
- UI: selection + confirm with count, total $, flagged (no lines, missing Zoho vendor/item, awaiting_info) → Approve N ready POs.

### PO bulk Zoho push
- `POST /api/v1/transactions/bulk-zoho-push` `{ ids: string[] (≤200) }`
- Sequential `pushPurchaseOrderToZoho`; `{ pushed, failed[] }`.
- Ready: approved or integration failed, no zohoRecordId, vendor + line item Zoho IDs present.

## Out of scope
Zoho mapping/vendor policy, sync history UX, structured error taxonomy (Phase 8 / C).

## Success
- `/api/v1/meta` → `0.26.0-alpha`
- PO queue bulk approve + bulk push without blind approval
- Expense bulk behavior unchanged
