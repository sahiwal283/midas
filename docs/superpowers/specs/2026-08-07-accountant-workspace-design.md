# Accountant Workspace — Design

**Date:** 2026-08-07
**Status:** Approved (UX specified by product review; roadmap sub-project B)

## 1. Server-side queue filtering

`GET /accountant/queue` accepts (all optional, AND-combined):
`status`, `userId` (employee), `search` (merchant/description ILIKE),
`amountMin`, `amountMax`, `from`, `to` (expense date), `categoryId`,
`paymentMethodId`, `reimbursementStatus`, `zohoStatus` (`synced` | `not_synced`
| `sync_failed`), `company` (zoho_entity), `sourceApp`, and boolean flags
`ocrNeedsReview`, `missingReceipt`, `missingCategory`, `missingPayment`.
Flag filters that map to SQL (`missingReceipt` via NOT EXISTS receipts,
`missingCategory` via null categoryId+zohoExpenseAccountId, `missingPayment`
via null paymentMethodId, `ocrNeedsReview` via EXISTS receipt with
ocr_needs_review) are done in SQL; response rows keep `flags`/`zohoReady` from
`computeFlags` as today. Employees list for the filter comes from
`GET /accountant/employees` (distinct users with queue expenses).

## 2. Bulk review (safe bulk approval)

`POST /accountant/expenses/bulk-review` `{ ids: string[] (≤200), action:
'approve' }` → per-item: approves only expenses whose status is reviewable
(pending/in_review) — others return `{ id, skipped, reason }`. Approval mirrors
the single-review path (status, reviewedBy, audit). Response
`{ approved: string[], skipped: Array<{id, reason}> }`.

**UI safety flow (client)**: selection dialog computes from loaded rows: count,
total $, and flagged subsets (missing receipt, missing category/payment,
unresolved requests = status awaiting_info). Button label: "Approve N ready
expenses" where ready = selected − flagged; flagged items are listed and NOT
approved. No blind approval.

## 3. Bulk Zoho push

`POST /accountant/zoho/bulk-push` `{ ids: string[] (≤200) }` → sequential
`pushExpenseToZoho` per id (status gate approved/zoho_sync_failed as the single
push), response `{ pushed: string[], failed: Array<{id, code, message}> }`.
UI: "Ready for Zoho" card on the queue — count + total $ of `zohoReady` rows +
"[Push N to Zoho]" → per-item result toast/summary ("16 synced, 1 requires
attention").

## 4. Split-screen review (desktop)

Queue row click → `/accountant/:id`: header (merchant, amount, Approve /
Reject / Ask buttons), left pane receipt image (largest receipt, object-fit
contain, links to full size), right pane: details (merchant, amount, date,
category, payment, company), Zoho readiness checklist (existing
`evaluateZohoReadiness` via existing readiness endpoint if present — else
compute client-side from flags), conversation (existing messages API), audit
trail link. Mobile falls back to stacked layout. Approve/Reject/Ask reuse the
existing review/message endpoints; after action, navigate back to the queue
(state preserved via query params).

## 5. Accountant dashboard

Dashboard page renders a role-specific accountant variant (accountant/admin/
developer see it in place of the employee dashboard when their role ≠ user…
admins keep it too): "Good morning, {name}" + queue table (Needs review,
Awaiting user, Zoho failed, Missing fields → each links to the filtered
queue), "$X ready for Zoho (N expenses)", "$Y awaiting reimbursement (M
employees)". Backed by an extended `GET /accountant/queue/summary` that adds
`readyForZohoAmount`, `reimbursementPendingAmount`, `reimbursementEmployees`.
Employee-role users keep the action-first dashboard from sub-project A.

## Testing

Vitest: bulk-review partitioning logic (reviewable vs skipped) as a pure lib
(`lib/bulkReview.ts`); filter param → SQL condition builder as a pure lib
(`lib/queueFilters.ts` returning drizzle conditions array — tested by shape).
Web via tsc + visual pass.

## Out of scope

Pagination (lists remain full-fetch for now — roadmap D), saved filters,
keyboard-driven review, notifications (F), close period.
