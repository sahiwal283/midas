# Accountant Review — Split Event and Daily, Retire the PO Queue

**Date:** 2026-08-12 · **Status:** Approved
**Goal:** Replace the single accountant review queue with two scoped pages — Event Review and Daily Review — each showing only its own expenses, each with reimbursements folded in as a lane. Remove the accountant Purchase Orders queue.

## Decisions (user-confirmed)

| Question | Decision |
|---|---|
| Event vs daily definition | Reuse the existing auto-push rule: daily = `source_app` null or `browser_extension`; event = anything else |
| Purchase Orders | Remove the **accountant review page only** — PO creation and Zoho PO push keep working |
| Lanes | Both pages carry the identical 10 lanes |
| Page names | **Event Review** and **Daily Review** |

## Starting state (measured 2026-08-12)

- `AccountantQueue.tsx` is **1,309 lines** and serves every lane for every expense type.
- Reimbursements is already lane #9 of 10; the sidebar "Reimbursements" entry is only a deep link to `/accountant?reimbursementStatus=pending`.
- The codebase already draws the daily/event line in `lib/autoApprove.ts`: `AUTO_PUSH_SOURCES = {null, 'browser_extension'}`, commented "Daily-expense auto-push" vs "Event/external expenses (trade_show, …) always require accountant approval."
- The browser extension sets `sourceApp: 'browser_extension'` (`routes/extensionExpenses.ts:94`).
- Production holds **0 purchase orders**; all 376 expenses are `trade_show` / `trade_show_event`.

## Design

### 1. Scope rule — enforced in SQL
New `scope` query parameter (`'event' | 'daily'`) on the accountant queue endpoints:

- **daily** → `source_app IS NULL OR source_app = 'browser_extension'`
- **event** → `source_app IS NOT NULL AND source_app <> 'browser_extension'`

Exact complements: every expense belongs to exactly one page, nothing falls between them, and neither page can render the other's rows. Filtering happens server-side — a client-side filter would still ship the opposite page's data to the browser. Partner-kind expenses stay excluded from both, unchanged.

Applies to `GET /accountant/queue`, `GET /accountant/expenses`, and `GET /accountant/queue/summary` so lane badges match the listed rows.

### 2. Two routes, one shared component
The queue body is extracted into a shared component parameterised by `scope`, with two thin route files:

- `/accountant/events` → Event Review
- `/accountant/daily` → Daily Review
- `/accountant` → redirect to `/accountant/daily`, so existing links, bookmarks and the expense-detail back button keep working.

Copy-pasting a 1,309-line page would create two files that drift; one parameterised component keeps a single place to fix bugs.

### 3. Lanes and reimbursements
Both pages carry the identical 10 lanes (Pending approval, Needs further review, Missing Receipt, Missing Expense Account, Missing Payment, Missing Company, Ready for Zoho, Zoho Failed, Reimbursement, All).

Reimbursements is already a lane, so folding it in means: delete the separate sidebar entry, and let each page's Reimbursement lane show only its own scope. Event reimbursements appear under Event Review, daily under Daily Review.

### 4. Purchase Orders
Delete the accountant PO queue page, its route `/accountant/purchase-orders`, and its sidebar entry. **Keep** PO creation (`PurchaseOrderNew`), the PO detail page, the transactions/PO API routes, and `zohoPoPush`. Accountants no longer approve POs; nothing else changes.

### 5. Entry points that must follow
- The accountant dashboard's four queue cards link to `/accountant?status=…` and need scope-aware targets.
- `lib/navActive.ts` (`accountantNavActive`) keys on the old `/accountant` paths and must be reworked for the new routes, keeping exactly one nav item active per page.
- The sidebar gains Event Review and Daily Review, and loses Purchase Orders and Reimbursements.

## Out of scope
- Any change to review, approval, or Zoho push behavior.
- The expense detail/review page (`AccountantReview.tsx`).
- Reports.
- PO creation, PO detail, or Zoho PO push.
- Adding an event picker to the Midas expense wizard (no Midas-native expense currently carries an `eventId`).
