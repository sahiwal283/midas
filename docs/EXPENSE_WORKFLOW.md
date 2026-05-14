# Midas Expense Lifecycle

## Status model

One `status` field on the `expenses` table covers the main review lifecycle. Reimbursement and Zoho sync are separate concerns tracked separately. "Missing fields" conditions are **derived flags**, never stored.

### Main lifecycle states

| Status | Who moves it there | Meaning |
|---|---|---|
| `draft` | System (on creation) | Employee has started but not submitted |
| `pending` | Employee (submit button / extension) | In accountant queue, waiting for first review |
| `in_review` | Accountant (claim action) or auto (on user reply to `awaiting_info`) | Accountant has claimed it; `reviewedById`/`reviewedAt` record who and when |
| `awaiting_info` | Accountant (`request_info` action) | Employee must respond before review can continue |
| `approved` | Accountant | Expense accepted; ready for Zoho once all fields complete |
| `zoho_sync_failed` | System (on failed Zoho push) | Approved but Zoho push failed; needs retry |
| `rejected` | Accountant | Not approved; terminal state |

**Transitions that can happen without accountant action:**
- Employee replies to `awaiting_info` → auto-transitions back to `in_review`, resolves all open requests.
- Extension submit → goes straight to `pending` (skips draft entirely).

**Claim/release transitions (accountant-initiated):**
- `POST .../claim` → `pending → in_review` (atomic conditional update; sets `reviewedById`/`reviewedAt`)
- `POST .../release-claim` → `in_review → pending` (atomic conditional update; clears `reviewedById`/`reviewedAt`)

### Separate reimbursement_status

| Value | Meaning |
|---|---|
| `not_requested` | No reimbursement needed |
| `pending` | Employee should be reimbursed; not yet processed |
| `approved` | Reimbursement approved |
| `paid` | Payment sent |

Set independently by accountant via `PATCH /api/v1/accountant/expenses/:id/reimbursement`.

### Derived flags (computed, not stored)

Computed by `computeFlags()` in `apps/api/src/routes/accountant.ts` from the already-fetched row. Never persisted to DB.

| Flag | Condition |
|---|---|
| `needs_category` | `categoryId` is null |
| `missing_receipt` | No receipts attached |
| `needs_payment_method` | `paymentMethodId` is null |
| `needs_entity` | `status='approved'` and `zohoEntity` is null |
| `ready_for_zoho` | `approved` + entity + category + payment method + receipt + not yet synced |
| `zoho_synced` | `zohoExpenseId` is set |
| `reimbursement_pending` | `reimbursementStatus='pending'` |
| `from_extension` | `sourceApp='browser_extension'` |

### Zoho readiness gate

An expense must pass all of these before `zoho-push` succeeds:
1. `status = 'approved'` (or `zoho_sync_failed` for retry)
2. `zohoEntity` set
3. `categoryId` set
4. `paymentMethodId` set

The `ready_for_zoho` flag also requires a receipt. The Zoho push endpoint enforces the first four programmatically; the receipt is a soft requirement (flag only).

---

## State machine diagram

```
[draft] ──submit──→ [pending]
                        │
              ┌─────────┤
              │         │ accountant acts
              ▼         ▼
         [rejected]  [in_review]
                        │
              ┌─────────┤
              │         │
              ▼         ▼
          [approved]  [awaiting_info]
              │             │
              │        user replies
              │             │
              │         [in_review]  ← auto-transition
              │
         zoho push fails
              │
       [zoho_sync_failed]
              │
         retry push
              │
          [approved]  ← restored on successful retry
```

---

## API surface

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/expenses` | User | Create draft |
| `PATCH` | `/api/v1/expenses/:id` | Owner | Update draft fields |
| `POST` | `/api/v1/expenses/:id/submit` | Owner | Submit draft → pending |
| `DELETE` | `/api/v1/expenses/:id` | Owner | Delete draft only |
| `POST` | `/api/v1/expenses/:id/receipts` | Owner/Privileged | Upload receipt |
| `POST` | `/api/v1/expenses/:expenseId/messages` | Owner/Privileged | Send message (auto-resolves awaiting_info if owner) |
| `PATCH` | `/api/v1/accountant/expenses/:id/review` | Accountant | approve / reject / request_info |
| `POST` | `/api/v1/accountant/expenses/:id/resolve-request` | Accountant | Manually close open requests |
| `PATCH` | `/api/v1/accountant/expenses/:id/reimbursement` | Accountant | Update reimbursement status |
| `PATCH` | `/api/v1/accountant/expenses/:id/zoho-entity` | Accountant | Set Zoho entity |
| `POST` | `/api/v1/accountant/expenses/:id/zoho-push` | Accountant | Push to Zoho |

---

## Source types

Expenses can arrive from multiple sources. The `sourceApp` and `sourceType` fields record origin without coupling logic to it.

| sourceApp | Description |
|---|---|
| `null` | Created directly in Midas web UI |
| `browser_extension` | Submitted via browser extension |
| `argo` | Delegated from Argo trade-show app |
| `milo` | Delegated from Milo payroll app |

Extension submissions bypass draft and enter `pending` immediately.
