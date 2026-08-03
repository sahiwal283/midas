# Zoho Mapping Review — Accounting Sign-Off Package

**Status:** Review only. No live Zoho records have been created. No live sync is enabled.  
**Prepared for:** Accounting / Operations reviewer  

> **2026-06-24 (v0.1.4-alpha) update.** Midas now builds a generic proposed payload (`servicePayload` in the readiness response) including a deterministic **idempotency key** (`midas-expense-<id>`) for duplicate prevention, a `reimbursable` flag (currently derived as `reimbursementStatus != not_requested` — pending decision A), and generic `source.{app,type,id,url,label}` provenance (no `event_id`, not trade-show coupled). The category→COA and payment-method→paid-through mappings below remain **accounting decisions** and appear as `proposedZohoAccount` / `proposedPaidThroughAccount` placeholders until filled in. Idempotency/duplicate prevention (decision J) must be confirmed on the integration-service side before live writes. The integration service is also **not yet authorized against Zoho** for `haute_brands` (`ZOHO_AUTH_INVALID`) — a service-side prerequisite independent of this sign-off.

**Midas version:** 0.1.1-alpha  
**Date:** 2026-05-21

---

## 1. Purpose

Midas is preparing to send approved expenses to Zoho Books through the shared Zoho Integration Service. Before any real data is written to Zoho, accounting must review and approve:

- which Midas fields map to which Zoho fields
- how to handle edge cases (reimbursable vs company card, missing vendor, etc.)
- which Midas categories correspond to which Zoho chart of accounts entries
- which payment methods map to which Zoho "paid through" accounts

This document is the basis for that review. Nothing in Zoho will change until accounting signs off and the operator explicitly enables live writes.

---

## 2. Current Mode

| Setting | Value | Meaning |
|---------|-------|---------|
| `ZOHO_MODE` | `mock` | Midas never contacts Zoho or the Zoho Integration Service |
| `ZOHO_DRY_RUN` | `true` | Even if mode=service, no real expense is created in Zoho |
| Live Zoho records created | **None** | Confirmed. No expense has been pushed to Zoho. |

Enabling live writes requires both explicit operator action and accounting sign-off. It cannot happen accidentally.

---

## 3. Zoho Readiness Requirements

Before Midas considers an expense eligible to send to Zoho, all of the following must be true:

| # | Requirement | Where it comes from |
|---|-------------|---------------------|
| 1 | Expense is **Approved** by an accountant | Review workflow in Midas |
| 2 | Expense has **not already been synced** to Zoho | Zoho ID field is blank |
| 3 | **Merchant name** is filled in | Entered by employee at submission |
| 4 | **Amount is greater than zero** | Entered by employee |
| 5 | **Expense date** is set | Entered by employee |
| 6 | A **submitting user** is on record | Always true for Midas-created expenses |
| 7 | **Category** is selected | Employee selects; accountant can update |
| 8 | **Payment method** is selected | Employee selects; accountant can update |
| 9 | **Accounting entity** (Zoho entity) is set | **Accountant sets this during review** |
| 10 | At least one **receipt** is attached | Employee uploads |
| 11 | No **open accountant requests** remain unresolved | Conversation is resolved |

If any of these are missing, the Zoho Readiness panel in the expense detail page will show exactly which items are missing.

---

## 4. Proposed Zoho Payload Mapping

This is what Midas proposes to send to Zoho Books for each approved expense. Accounting must confirm each field is correct before live writes are enabled.

| Midas Field | Proposed Zoho Books Field | Source | Required | Open Question |
|-------------|--------------------------|--------|----------|---------------|
| `merchant` | Vendor / Payee name | Employee-entered | Yes | How should this match against the Zoho vendor list? Create new vendor if not found, or reject? |
| `amount` | Amount | Employee-entered | Yes | — |
| `currency` | Currency (default: USD) | Employee-entered | Yes | — |
| `date` | Expense date | Employee-entered | Yes | — |
| `description` | Notes / Description | Employee-entered | No | — |
| `category.name` | Category | Midas category name (see §5) | Yes | **Mapping needed** — see §5 |
| `paymentMethod.label` | Paid Through / Account | Payment method label (see §6) | Yes | **Mapping needed** — see §6 |
| `zohoEntity` | Accounting entity / Book | Set by accountant during review | Yes | Accountant sets this per-expense today. Should it default from the employee's department? |
| `brand` | Zoho Books organisation | `haute_brands` (fixed) | Yes | Correct Zoho Books org confirmed (org_id 856048585) |
| `reimbursementStatus` | (drives expense type) | Set by accountant | Informational | See §7 — key open decision |
| `receipts[0]` | Attachment | File stored in Midas | No (but required for readiness) | Will Midas attach the receipt file to the Zoho expense record, or just include the Midas URL? |

### Fields Midas does NOT currently send (may need to)

| Field | Notes |
|-------|-------|
| Employee / Submitter | Zoho may require a linked employee record for reimbursable expenses |
| Zoho vendor ID | If Zoho requires a vendor ID rather than a free-text vendor name |
| Tax information | No tax capture in Midas today |
| Project / Department code | Not in Midas schema today |
| Custom fields | Zoho Books supports custom expense fields — not mapped yet |

---

## 5. Category → Zoho Chart of Accounts Mapping

Midas has the following built-in expense categories. Accounting must decide which Zoho chart of accounts (COA) account each maps to. The column on the right is blank — **accounting must fill this in.**

| Midas Category | Description | Proposed Zoho COA Account |
|----------------|-------------|---------------------------|
| Meals & Entertainment | Business meals, team lunches, client dinners | _[accounting to specify]_ |
| Travel | Flights, trains, long-distance transportation | _[accounting to specify]_ |
| Accommodation | Hotels, short-term lodging | _[accounting to specify]_ |
| Transportation | Taxis, rideshare, car rental, parking, fuel | _[accounting to specify]_ |
| Office Supplies | Stationery, printer supplies, desk accessories | _[accounting to specify]_ |
| Software & Subscriptions | SaaS tools, app subscriptions | _[accounting to specify]_ |
| Marketing & Advertising | Trade show materials, ads, promotional items | _[accounting to specify]_ |
| Professional Services | Consultants, legal, accounting fees | _[accounting to specify]_ |
| Equipment | Hardware, tools, non-consumable purchases | _[accounting to specify]_ |
| Other | Uncategorized / catch-all | _[accounting to specify]_ |

> **Action required:** Accounting fills in the Zoho COA column and confirms the mapping before any expense is pushed.

---

## 6. Payment Method → Zoho "Paid Through" Account Mapping

Payment methods in Midas represent the card or account used to pay the expense. Each must map to a Zoho Books "paid through" account. Admins create payment methods in Midas under Admin → Payment Methods. Each payment method has an optional `zoho_account_name` field that, when set, is surfaced as a warning in the Zoho Readiness panel.

| Midas Payment Method | Zoho "Paid Through" Account |
|---------------------|-----------------------------|
| _[admin-created — fill in from your actual list]_ | _[accounting to specify]_ |

> **Action required:** Admin exports the active payment methods list. Accounting assigns a Zoho "paid through" account to each. Admins then set the `Zoho Account Name` field on each payment method in Midas (Admin → Payment Methods → Edit).

---

## 7. Open Accounting Decisions

These questions must be answered before live Zoho writes are enabled. They affect how Midas maps expenses.

**A. Reimbursable vs. company-card expenses — how should they differ in Zoho?**
- Company-card expenses (employee paid on company card) → likely create a Zoho Books expense directly.
- Employee-reimbursable expenses (employee paid out of pocket) → may need to be a bill payable to the employee, or an expense with a reimbursement flag, or a separate Zoho Expense report.
- _Decision needed:_ Which Zoho module/record type for each?

**B. Which Zoho module? Zoho Books expenses, bills, Zoho Expense, or journal entries?**
- Midas is currently mapped to Zoho Books (`/books/v3/expenses`), not Zoho Expense.
- _Confirm:_ Is Zoho Books (not Zoho Expense) correct for all expense types?

**C. Employee reimbursement flow in Zoho**
- If an expense is reimbursable, does Zoho Books need a linked employee/vendor record to generate a payment?
- _Decision needed:_ How is reimbursement tracked in Zoho — via expense, bill, or payroll?

**D. Vendor/merchant handling**
- Zoho Books has a vendor list. Should Midas try to match `merchant` against existing Zoho vendors, or always create a new one?
- What happens when the merchant is informal (e.g. "Uber", "Amazon")?
- _Decision needed:_ Exact-match required, fuzzy-match allowed, or free-text always?

**E. Category → COA mapping** _(see §5 above)_
- Accounting must provide the COA account for each Midas category.

**F. Payment method → paid-through account mapping** _(see §6 above)_
- Accounting must provide the Zoho "paid through" account for each Midas payment method.

**G. Who sets the accounting entity (zohoEntity) per expense?**
- Today: accountant sets `zohoEntity` manually during review.
- _Optional improvement:_ Should it default from the employee's cost centre, department, or brand?

**H. What happens on OCR mismatch?**
- OCR may extract a different merchant, amount, or date than what the employee entered.
- _Decision needed:_ Does Midas send the employee-entered values or the OCR-suggested values? (Current: employee-entered always wins — OCR is advisory.)

**I. All approved expenses eligible, or only explicitly marked?**
- Today: any approved expense with all required fields is considered ready.
- _Option:_ Require accountant to click an explicit "Mark for Zoho sync" action.
- _Decision needed:_ Automatic on approval (with fields complete) or explicit accountant action?

**J. Duplicate / idempotency handling**
- What should happen if the same expense is submitted to Zoho twice?
- The integration service may handle idempotency at the HTTP level — this needs verification.
- _Decision needed:_ Block at Midas level (Zoho ID already set), at integration service level, or both?

---

## 8. Hard Gates Before Live Writes

The following must all be true before `ZOHO_MODE=service` and `ZOHO_DRY_RUN=false` are set on CT 3120:

- [ ] **Accounting has approved the field mapping** (§4)
- [ ] **Category → COA mapping is complete** (§5)
- [ ] **Payment method → paid-through account mapping is complete** (§6)
- [ ] **Open decisions A–J are resolved** (§7)
- [ ] **Dry-run validation succeeds** — at least one real approved expense evaluated, payload reviewed by accounting, no issues
- [ ] **Idempotency / duplicate prevention is verified** — same expense submitted twice does not create two Zoho records
- [ ] **Error handling path is reviewed** — what happens when Zoho rejects an expense?
- [ ] **Live write permission confirmed** with Zoho Integration Service operator
- [ ] **Operator explicitly sets `ZOHO_MODE=service` and `ZOHO_DRY_RUN=false`** on CT 3120 and restarts API

---

## 9. How Accountants See Readiness Today

Accountants and admins can check Zoho readiness for any expense right now — no live Zoho call occurs.

**Steps:**
1. Log in to Midas as accountant or admin: [http://192.168.1.210:5173](http://192.168.1.210:5173)
2. Go to the **Accountant → Review Queue** or find the expense in **My Expenses** list.
3. Open any expense by clicking on it.
4. In the right sidebar, find the **Zoho Readiness** panel.
5. The panel shows:
   - Current mode badge ("Mock mode — no real sync occurs")
   - A checklist of all 11 readiness requirements, each showing pass ✓ or fail ✗
   - A **Missing fields** list (in plain language) if anything is incomplete
   - A **"Proposed Zoho payload (preview only)"** section — visible only when all fields are present — showing exactly what would be sent to Zoho
   - Any warnings (e.g. reimbursement pending, payment method account mapping)

**What normal (non-accountant) users see:**
Nothing. The Zoho Readiness panel is not shown to regular employees. They never see Zoho errors, Zoho IDs, or any Zoho-related information.

**API access (for integration testing):**
```
GET /api/v1/expenses/:id/zoho-readiness
Authorization: session cookie (accountant or admin role required)
```
Returns JSON — see `docs/examples/zoho-readiness-sample.json` for example responses.

---

## 10. Accounting Sign-Off Checklist

When the accounting reviewer is satisfied with the mapping, please confirm the following in writing (email or issue comment):

- [ ] I have reviewed the proposed Zoho field mapping (§4) and it is correct / I have notes (attached)
- [ ] I have completed the Category → COA mapping table (§5)
- [ ] I have completed the Payment method → Paid-through account mapping table (§6)
- [ ] I have answered open decisions A–J (§7), or noted which can be deferred
- [ ] I understand that no live Zoho records will be created until I confirm and the operator explicitly enables live writes
- [ ] I approve proceeding to dry-run validation once the above are complete

**Reviewer:** ___________________________  
**Date:** ___________________________  
**Notes:** ___________________________
