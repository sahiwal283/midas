# Expense Lifecycle Integrity — Design

**Date:** 2026-08-07
**Status:** Approved (roadmap sub-project D)

## Edit rules by state

Pure lib `apps/api/src/lib/expenseEdit.ts`:

```ts
editableFields(status: string, zohoExpenseId: string | null): 'all' | 'notes_only' | 'none'
```

- Zoho-synced (`zohoExpenseId` set): **none** — never silently editable. A synced
  correction is an explicit workflow (admin force-delete + re-entry today;
  reversal records later).
- `draft`: all. `awaiting_info`: all (user is being asked to fix things).
- `pending`: **notes_only** (`description`) — the amount/merchant/date the
  accountant sees must not shift under them.
- `in_review`, `approved`, `rejected`, `zoho_sync_failed`: none.

`PATCH /expenses/:id` enforces this (today it allows drafts only — this both
loosens awaiting_info/pending and hardens the synced case). 409
`NOT_EDITABLE` with a state-specific message otherwise.

## Rejected → corrected expense

`POST /expenses/:id/clone` (owner only, source must be `rejected`): creates a
new **draft** copying merchant, amount, currency, date, category, payment
method, company, Zoho account fields, description — NOT receipts (files belong
to the original; the wizard/detail page prompts to attach) and NOT review or
Zoho state. Audit `cloned_from_rejected` on the new expense (metadata:
sourceExpenseId). Response `{ expense }`. UI: rejected expenses show the
rejection reason (latest accountant message) + "[Create corrected expense]" →
navigates to the new draft.

## Duplicate detection

`POST /expenses/check-duplicate` `{ merchant, amount, date }` (authenticated,
scoped to the caller): finds the caller's non-rejected, non-draft expenses with
same date ±3 days, same amount (exact), and case-insensitive merchant overlap
(either contains the other, ignoring punctuation). Returns
`{ duplicate: { id, merchant, amount, date, status } | null }`. Pure matcher
`isLikelyDuplicate(candidate, existing)` in `apps/api/src/lib/duplicates.ts`
with tests. Wizard calls it before submit; a match shows "⚠ Possible duplicate:
{merchant} — ${amount} — {date}. Similar expense submitted {date}." with
"Submit anyway" / "Cancel". Non-blocking.

## Server-side pagination (API groundwork)

`GET /expenses` accepts optional `page`, `pageSize` (≤100), `search`
(merchant/description ILIKE), `status`, `from`, `to`. When `page` is present
the response becomes `{ expenses, total, page, pageSize }`; without it the
legacy full-array shape is unchanged (existing clients keep working). The
employee UI stays client-side for now (per review: "eventually"); accountant
queue is already server-side.

## Testing

Vitest: `editableFields` matrix; `isLikelyDuplicate` matrix (amount/date
window/merchant fuzz). Web via tsc + visual pass.

## Out of scope

Synced-expense reversal records, receipt file duplication on clone, close
period (H), UI pagination switchover.
