# Reimbursement Definition — Design

**Date:** 2026-08-07
**Status:** Approved (roadmap sub-project G)

## Semantics

Payment is intentionally manual: Midas never moves money. All UI copy uses
**"Mark as paid"** — never "Pay employee". (Audit action stays
`reimbursement.updated`.)

## Employee view

My Expenses gains a **Reimbursements** filter chip row (visible only when the
user has any expense with reimbursementStatus ≠ not_requested): All ·
Pending · Approved · Paid — client-side filter on the already-loaded rows
(consistent with the page's other filters). Each matching row shows the
existing ReimbursementBadge.

## Accountant dashboard

Already shipped in sub-project B ($ awaiting + employee count). Verify the
lane link goes to `/accountant?reimbursementStatus=pending` (queue reads the
param like `?status=`).

## Reports

`/reports/summary` adds a `reimbursement` block computed in the same scope:

```ts
reimbursement: {
  reimbursableTotal: number;   // spend on requires-reimbursement expenses (status != not_requested)
  companyCardTotal: number;    // spend where reimbursementStatus == 'not_requested'
  outstanding: number;         // pending + approved (not yet paid)
  paid: number;
  byEmployee: Array<{ name: string; outstanding: number; paid: number }>; // top 10 by outstanding
}
```

Reports page gains a "Reimbursements" section: 4 stat tiles (Reimbursable /
Company card / Outstanding / Paid) + a small by-employee table.

## Testing

Reports block covered by SQL aggregates + tsc; accountant queue param and
labels by grep/visual. No new pure-lib logic.
