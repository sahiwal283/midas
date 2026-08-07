# Zoho Pipeline Completion — Design

**Date:** 2026-08-07
**Status:** Approved (roadmap sub-project C; policies below settle the open
mapping decisions and are the canonical reference)

## Settled policies (the "unresolved accounting decisions")

| Decision | Policy |
|---|---|
| Record type | Zoho Books **expense records** via Integration Service `create_books` (as shipped). |
| Category → COA | Daily expenses: user picks the live COA account (wizard); Trade Show: Midas category → static `expense_categories.zoho_account_id` map. OCR category suggestion preselects the COA pick when it matches an account name — user can always change it. |
| Payment method → paid-through | `payment_methods.zoho_account_name` (paid-through account id), maintained in Admin → Payment Methods. Missing mapping blocks push with `MAPPING_ERROR`. |
| Reimbursable vs company card | Personal cards push with paid-through = Employee Reimbursements and enter the reimbursement lane; company cards use their own paid-through. (As shipped.) |
| Company (entity) assignment | Auto-derived from the card's `defaultZohoEntity`, user-editable; companies with `zoho_enabled=false` (Summitt Labs) never push. |
| Explicit vs automatic sync | Automatic for complete staff-entered daily expenses (auto-push on submit); explicit accountant push for event expenses and anything incomplete. |
| Duplicate prevention (Zoho side) | Idempotency key per expense (`buildIdempotencyKey`) on every push; the service dedupes on it. Midas-side duplicate *detection* is roadmap sub-project D. |
| Vendor handling | **Midas never creates Zoho vendors.** Merchant text rides along for the record description only; vendor matching (exact → alias → flag accountant → create only if configured) is the Integration Service's job and is documented as its contract. |
| OCR mismatch behavior | OCR-flagged receipts (`ocr_needs_review`) do NOT block auto-push: the submitter confirmed the fields in the wizard. Accountants can filter the queue by "OCR needs review" for spot checks. |

## Structured error codes + auto-retry

New `apps/api/src/lib/zohoErrors.ts`:

```ts
export type ZohoErrorCategory =
  | 'AUTH_ERROR' | 'MAPPING_ERROR' | 'VALIDATION_ERROR' | 'RATE_LIMIT'
  | 'NETWORK_ERROR' | 'ZOHO_ERROR' | 'DUPLICATE' | 'UNKNOWN';
export function classifyZohoError(err: unknown): { category: ZohoErrorCategory; retryable: boolean }
```

Classification: `ZohoServiceError` codes `ZOHO_AUTH_INVALID`/`ZOHO_AUTH_FORBIDDEN`
→ AUTH_ERROR (not auto-retryable); HTTP 429 → RATE_LIMIT (retryable); HTTP ≥500
→ ZOHO_ERROR (retryable); code containing `DUPLICATE` → DUPLICATE (not
retryable); HTTP 400/422 → VALIDATION_ERROR (not retryable; message mentioning
account/entity/paid_through → MAPPING_ERROR); non-service errors that look like
network failures (ECONN*, ETIMEDOUT, fetch/network/timeout in message) →
NETWORK_ERROR (retryable); everything else UNKNOWN (not retryable).

`pushExpenseToZoho` wraps the service call in a retry loop: up to 2 retries
(2s, 5s backoff) only when `retryable`. On terminal failure it now ALSO writes
`expenses.zoho_sync_error = "[CATEGORY] message"`; on success it clears it.
The outcome and the `zoho.failed` audit entry include the category.

## Sync history UI (no new endpoint)

The expense row already carries everything: `zohoExpenseId`, `zohoSyncedAt`,
`zohoSyncError`, plus the audit trail (`GET /accountant/expenses/:id/audit`).
New shared web component `ZohoSyncCard` rendered on the accountant views
(ExpenseDetail's accountant panel + AccountantReview right pane):

- Synced: "Zoho ✓ Created — {date} · Zoho Expense ID {id}".
- Failed: "Zoho ⚠ Sync failed — Reason: {zohoSyncError}" + [Retry] button
  (existing single-push endpoint).
- Not pushed: "Zoho — not pushed yet".
- Employees never see this card (existing sanitization already nulls
  `zohoSyncError` for non-accountants).

## Category preselect from OCR (wizard)

If `receipt.ocrData.fields.category.value` exists and the loaded COA account
list has a case-insensitive name match (contains), preselect that account
after OCR completes — never overriding a user's explicit pick.

## Testing

Vitest: `classifyZohoError` matrix (each category + retryable flags).
Retry loop kept thin (delay fn injectable? no — fixed waits, loop logic covered
by classify tests + typecheck). Web via tsc + visual pass.

## Out of scope

Merchant normalization (H), Midas-side duplicate detection (D), service-side
vendor alias tables (Integration Service backlog), batch retry scheduler.
