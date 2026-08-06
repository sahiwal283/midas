# Daily Expense Auto-Push — Design

**Date:** 2026-08-06
**Status:** Approved

## Purpose

Complete daily expenses entered by staff in Midas should not wait for accountant
approval: on submit they are auto-approved and pushed to Zoho immediately. The
accountant remains a gate only for event expenses (Trade Show app) and for
incomplete daily expenses, and keeps oversight lanes for everything.

## Eligibility

New pure lib `apps/api/src/lib/autoApprove.ts`:

```ts
isAutoPushEligible(i: { sourceApp: string | null; ready: boolean }): boolean
```

- Eligible iff `(sourceApp === null || sourceApp === 'browser_extension')` AND `ready`.
- `ready` comes from the existing `evaluateZohoReadiness(expense).ready` — the
  canonical "all info Zoho needs is present" check (entity, category/COA account,
  payment method with paid-through, amount, merchant, not already synced).
- Any other `sourceApp` (e.g. `trade_show` via the ext API) is NEVER eligible —
  event expenses always require accountant approval.

## Shared push lib

Extract the Zoho push block from `routes/accountant.ts` (`POST /expenses/:id/zoho-push`)
into `apps/api/src/lib/zohoPush.ts`:

```ts
pushExpenseToZoho(expense: ExpenseWithRelations, actorUserId: string): Promise<
  | { ok: true; expense: Expense; zoho: ZohoPushResult }
  | { ok: false; status: number; code: string; message: string; requestId?: string }>
```

Behavior identical to today: validates entity/category/payment method/account ids
(409 codes unchanged), pushes via `zoho.pushExpense`, on success sets
`status='approved'`, `zohoExpenseId`, `zohoSyncedAt` + audit `zoho.pushed`; on
failure sets `status='zoho_sync_failed'` + audit `zoho.failed`. The accountant
route becomes a thin wrapper and its API contract does not change.

## Submit flow

`POST /expenses/:id/submit` (routes/expenses.ts):

1. Load the expense with receipts/category/paymentMethod relations.
2. Evaluate readiness; check `isAutoPushEligible`.
3. **Not eligible** → `status='pending'` (today's behavior, audit `submitted`).
4. **Eligible** → `status='approved'` with `reviewedById=null`, audit
   `auto_approved` (before: draft, after: approved, metadata: readiness summary),
   then `pushExpenseToZoho(...)` with the submitter as actor:
   - Push success → response includes the approved+synced expense.
   - Push failure → expense is `zoho_sync_failed` (set by the lib), which appears
     in the accountant queue for retry. Submit still returns 200 with the expense —
     the user's part is done; recovery is the accountant's lane.

## Accountant oversight

No changes needed: the queue's statuses already include `approved` and
`zoho_sync_failed`, and reimbursable (personal-card) expenses keep
`reimbursementStatus='pending'` → they stay in the Reimbursement lane until paid,
even though the expense itself auto-pushed (the approved hybrid).

## Web

No UI changes required: My Expenses already renders `approved` as "Approved".
(The submitter simply sees Approved instead of Pending approval when eligible.)

## Testing

- `autoApprove.test.ts`: source-app matrix (null ✓, browser_extension ✓,
  trade_show ✗, other ✗) × ready true/false.
- Existing accountant zoho-push behavior covered by unchanged route contract;
  `zohoPush.ts` extraction is behavior-preserving (verified by full suite + lint).

## Out of scope

Daily batch scheduler (immediate push chosen), per-category or per-user opt-outs,
retry/backoff beyond the existing accountant retry button, changes to ext-API or
Trade Show flows.
