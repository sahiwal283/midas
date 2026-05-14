# Midas Accountant Workflow

## Overview

Accountants (and admins) access the workspace at `/accountant`. It is organized into **action-oriented queues**, not a single filterable table.

---

## Queue lanes

### Needs Attention

| Lane | Filter | Action |
|---|---|---|
| **Needs Review** | `status = 'pending'` | New — click "Mark as Reviewing" to claim |
| **In Review** | `status = 'in_review'` | Claimed — approve, reject, or ask |
| **Awaiting User** | `status = 'awaiting_info'` | Employee must respond; can resolve early |
| **Zoho Failed** | `status = 'zoho_sync_failed'` | Retry push |

### Missing Fields (approved expenses that can't reach Zoho yet)

| Lane | Filter | Action |
|---|---|---|
| **Missing Receipt** | `approved` + `missing_receipt` flag | Ask employee to upload, or waive |
| **Missing Category** | `approved` + `needs_category` flag | Set category directly or ask |
| **Missing Payment** | `approved` + `needs_payment_method` flag | Set payment method or ask |
| **Missing Entity** | `approved` + `needs_entity` flag | Set Zoho accounting entity |

### Ready & Processing

| Lane | Filter | Action |
|---|---|---|
| **Ready for Zoho** | `ready_for_zoho` flag (all required fields present) | Push to Zoho |
| **Reimbursement** | `reimbursementStatus = 'pending'` | Process payment |
| **All Expenses** | Everything | Overview/search |

---

## Claiming an expense

An accountant clicks **Mark as Reviewing** on a `pending` expense. This:
- Atomically transitions `pending → in_review` using a conditional update (`WHERE status = 'pending'`)
- Records `reviewedById` (who) and `reviewedAt` (when) on the expense
- Logs a `review.claimed` audit event
- Returns 409 CONFLICT if the expense is no longer `pending` (prevents two accountants claiming simultaneously)

Once claimed, the expense appears in the **In Review** lane. The reviewer's name is shown on the queue row and in the expense detail. The expense owner sees "Under review" in the status banner.

## Releasing a claim

An accountant (or admin) clicks **Release Claim** on an `in_review` expense. This:
- Atomically transitions `in_review → pending` using a conditional update (`WHERE status = 'in_review'`)
- Clears `reviewedById` and `reviewedAt` on the expense row
- Logs a `review.released` audit event with the previous reviewer and timestamp
- Returns 409 CONFLICT if the expense is not currently `in_review`
- Returns the expense to the **Needs Review** queue

**Authorization gap (known):** The API currently allows *any* accountant/admin to release any `in_review` expense. The intended rule is that only the claiming reviewer or an admin should be able to release. This is enforced in the UI (Approve/Reject/Ask are hidden for non-claiming accountants) but not enforced in the API. A future improvement would add a server-side check: `WHERE reviewedById = req.user.id OR req.user.role = 'admin'`.

---

## Reviewing an expense

### From the queue row
- **Mark as Reviewing** — claims the expense (`pending → in_review`). Shows in the "In Review" lane.
- **Approve** — marks as `approved`. Set Zoho entity in the approve form if known. *(Only shown to the claiming reviewer or admin.)*
- **Reject** — marks as `rejected`. Optional note becomes a system message. *(Only shown to the claiming reviewer or admin.)*
- **Ask** — transitions to `awaiting_info`. *(Only shown to the claiming reviewer or admin.)*
- **Release** — releases the claim (`in_review → pending`). Shown to all accountants/admins on `in_review` rows.

### Request types
| Type | Use when |
|---|---|
| `info_request` | General question |
| `missing_receipt` | Employee forgot to upload |
| `missing_category` | Category unclear |
| `missing_payment_method` | Which card/payment used |

### From the expense detail page
The full detail page (`/expenses/:id`) shows:
- **Zoho Readiness panel** — checklist of all required fields with pass/fail
- **Conversation thread** — all messages, request bubbles (with internal note for accountants), system events
- **Receipts** — files with OCR status
- **"Mark all resolved"** button when expense is `awaiting_info` with open requests

---

## Requesting info

When selecting **Ask** on a queue row:
1. Choose a request type from the dropdown (affects the badge shown to employee)
2. Write the message visible to the employee
3. Optionally write an internal note (shown only to accountants in the conversation)
4. Click **Send**

The expense moves to `awaiting_info`. The employee will see a prominent "Action needed" banner.

When the employee replies, all open requests auto-resolve and the expense returns to `in_review` automatically. You can also manually resolve requests from the detail page.

---

## Zoho push flow

1. Expense must be `approved` with:
   - Zoho entity set
   - Category set
   - Payment method set
   - (Soft) Receipt attached
2. The `Ready for Zoho` queue shows expenses that pass all checks.
3. Click **Push to Zoho** from the queue row or detail page.
4. On failure: expense moves to `zoho_sync_failed`. Retry from the Zoho Failed queue.

Set Zoho entity via:
- During approval: fill the optional "Zoho entity" field in the approve form
- After approval: `PATCH /api/v1/accountant/expenses/:id/zoho-entity`

---

## Reimbursement

Set via `PATCH /api/v1/accountant/expenses/:id/reimbursement`:
- `pending` — mark that employee should be reimbursed
- `approved` — reimbursement approved
- `paid` — payment sent

The optional note becomes a system message visible to the employee.

---

## Audit trail

Every status transition, review action, reimbursement change, Zoho push, and message is recorded in `audit_logs` with `before` and `after` state. The audit log is immutable and append-only.
