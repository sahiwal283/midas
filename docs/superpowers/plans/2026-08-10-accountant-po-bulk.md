# Accountant Polish + PO Bulk — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-08-10-accountant-po-bulk-design.md`  
**Version:** `0.26.0-alpha`

## Tasks
1. API `POST /transactions/bulk-review` + `POST /transactions/bulk-zoho-push`
2. Pure helpers + vitest for PO ready/flagged partitioning
3. PO queue: selection, bulk approve modal, bulk push
4. Brand polish: AccountantQueue, AccountantReview, PurchaseOrderQueue, accountant Home
5. Web API client methods; bump version; deploy; verify `/meta`
