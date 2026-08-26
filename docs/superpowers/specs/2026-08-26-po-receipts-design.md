# Receipts on purchase orders, and retiring the PO number field — design

Approved in chat 2026-08-26. Purchase orders require a receipt like any other
spend, but Midas has no way to hold one. This adds receipt upload, OCR and Zoho
attachment to POs, and retires a PO number field that never did anything.

## The problem

The Add Transaction screen tells users a purchase order has "no receipt to
scan". That is not a description of the business rule — POs do require a
receipt — it is a description of a gap in Midas:

- **A PO cannot hold a receipt at all.** `receipts.expense_id`
  (`apps/api/src/db/schema.ts:361`) is `NOT NULL` and references `expenses`. A
  purchase order is a `transactions` row with no expense, so there is nothing
  for a receipt to hang from.
- **The Zoho payload pretends otherwise.** `buildZohoPoServicePayload`
  (`apps/api/src/lib/zohoPoPayload.ts:100`) emits `receipt: { count }`, but
  `zohoPoPush.ts` never sets `receiptCount`, so the field is always null — and
  it only ever carried a count, never a file.
- **The PO number field is inert.** `PurchaseOrderNew.tsx:188` collects it,
  `transactions.ts:250` stores it in `purchase_orders.po_number` — and
  `toZohoBooksPoCreateBody()` (`zohoPoPayload.ts`) never copies it into the
  Books body. The only identifier that reaches Zoho is `reference_number`, set
  to the idempotency key `midas-po-<uuid>`. Zoho assigns its own number
  regardless, and Midas never learns what it is.

## Context discovered

- **The service side of receipt attachment is already contracted.**
  `docs/ZOHO_PO_CONTRACT.md:14` lists `POST /zoho/purchaseorders/attach_receipt`
  and line 88 lists the `purchaseorders.attach_receipt` capability grant. Midas
  has no client for it: `lib/zoho.ts` exports `attachReceiptToBooksExpense` and
  no PO equivalent.
- **OCR is owner-agnostic.** The pipeline runs off the stored file and writes
  `ocr_status` / extracted fields back onto the receipt row. Nothing in it
  reads `expense_id`, so a PO receipt gets scanned with no OCR changes.
- **There is no way to read a PO back from Zoho.** The contract's endpoint
  table (`ZOHO_PO_CONTRACT.md:8-16`) lists create, attach_receipt, vendors/list
  and items/list — no `purchaseorders/get` — and the documented create response
  is `{"purchaseorder_id": "<books_po_id>"}` with no `purchaseorder_number`.
- **Receipt authorization currently routes through the expense.** The content
  route (`routes/receipts.ts:112-115`) loads the receipt, then loads its
  expense to decide access. PO receipts need the equivalent through the
  transaction.
- **`maybeAutoPushPending` is expense-only.** `routes/receipts.ts:77,86` calls
  it after upload; it must not run for a PO receipt.

## Decisions

1. **Receipts become polymorphic.** Add nullable `transaction_id`, make
   `expense_id` nullable, and constrain exactly one to be set. Rejected: a
   parallel `po_receipts` table (duplicates the OCR pipeline, the file-serving
   route and the preview UI permanently) and a shadow expense row per PO
   (pollutes expense queries, Daily Review and Reports with rows that are not
   expenses).
2. **This ships as a real migration**, not `db:push`. Production holds ~380
   live receipt rows; the change is additive so no existing row is rewritten.
3. **OCR runs on PO receipts, and fills nothing.** A receipt's extraction shape
   is merchant/amount/date, which does not map onto PO line items. The text is
   stored and shown; no auto-fill is attempted. Building line-item extraction
   is a separate feature, not this one.
4. **Attachment failure never fails the push.** Same rule as expenses
   (v1.3.2): the Books record exists, so a failed attach marks the PO with a
   `[RECEIPT_WARNING]` and is logged at error level — never silent, never a
   reason to re-push a record that already exists.
5. **The PO number input is removed and the column repurposed** to hold the
   number Zoho assigns, displayed read-only. Rejected: keeping it as an
   optional override (wiring a rare manual case into the Books body is more
   code than removal, for a case the user says almost never happens).
6. **A missing receipt does not block the push.** POs require a receipt as a
   business rule, but enforcing it as a hard gate would strand every PO already
   in flight without one. A receipt-less PO pushes and is flagged, the same way
   `missing_receipt` works for expenses. If it should instead refuse the push,
   that is a one-line change to the readiness check — say so at review rather
   than after the queue fills with blocked POs.
7. **`receiptCount` gets populated, not removed.** The field is part of the
   agreed service contract; a true count is more useful to the service than
   deleting the field and re-adding it later. It reports the number of receipts
   on the PO at push time.

## Architecture

### Schema

```
receipts
  expense_id      uuid NULL  references expenses(id)     on delete cascade
  transaction_id  uuid NULL  references transactions(id) on delete cascade
  CHECK ((expense_id IS NOT NULL) <> (transaction_id IS NOT NULL))
  index receipts_transaction_id_idx on (transaction_id)
```

The `CHECK` is what keeps "polymorphic" from becoming "ambiguous": a row with
both owners set, or neither, cannot exist.

**Blast radius to expect:** `receipts.expenseId` becomes `string | null` in
Drizzle's inferred types, so every existing reader must handle null. The known
readers are `routes/receipts.ts` (eight sites), `lib/zohoPush.ts:143`, and the
`missing_receipt` flag's `not exists (... where r.expense_id = ...)` subquery in
`routes/accountant.ts` — which stays correct as written, because a PO receipt
has a null `expense_id` and therefore cannot satisfy it.

### Upload and OCR

The receipts router mounts a second time, at
`/api/v1/transactions/:transactionId/receipts`, alongside the existing
`/api/v1/expenses/:expenseId/receipts` (`server.ts:86`). A small resolver turns
whichever route param is present into `{ column, id, authorize() }`, so both
mounts share one handler, one OCR call and one uploads directory.

Two behaviours are owner-specific and must branch:

- `maybeAutoPushPending` runs only for expense receipts.
- Authorization resolves through the transaction for PO receipts, and through
  the expense for expense receipts — including on the content route.

### Zoho attachment

`zohoPoPush` gains the attach step, modelled on `zohoPush.ts:135-170`: read the
oldest receipt for the transaction, `POST /zoho/purchaseorders/attach_receipt`,
and on failure record a `[RECEIPT_WARNING]` on the PO and log with the storage
path and configured uploads directory. The payload's `receiptCount` is
populated with the PO's real receipt count, so the field stops being a
permanently-null lie.

**Pre-flight requirement:** the `purchaseorders.attach_receipt` capability must
be granted in the Zoho integration service's Postgres, via that repo's
`scripts/grant_midas_po_capabilities.py`. Without it every attach 403s and every
PO acquires a receipt warning. Verify the grant *before* shipping, not after.

### PO number

The input is removed from `PurchaseOrderNew.tsx`, and `poNumber` is dropped
from the create payload. `purchase_orders.po_number` is kept and re-purposed:
it now holds the number Zoho assigned, written on push and rendered read-only
on the PO detail (`PurchaseOrderDetail.tsx:150` already renders it when
present, so that display needs no change).

## The dependency this design cannot satisfy

**Midas cannot obtain Zoho's PO number today.** The create response returns
only `purchaseorder_id`, and no endpoint exists to read a PO back. Everything
above is built so the number appears the moment the service provides it — the
column, the write on push, the read-only display — but until the Zoho
integration service either returns `purchaseorder_number` in its create
response or exposes a `purchaseorders/get`, the field will simply be absent.

That change lives in the Zoho integration service repository, not in Midas.
It is a separate request to whoever owns that service. This spec does not
assume it, and nothing else here is blocked by it: receipt upload, OCR and
attachment all ship regardless.

## Testing

Unit, no database:

- The owner resolver: expense param → expense owner; transaction param →
  transaction owner; the exactly-one-owner rule rejected in both failing
  directions (both set, neither set).
- The attach-failure path produces a `[RECEIPT_WARNING]` and leaves the PO's
  Zoho record id intact — a failed attach must never look like a failed push.

Migration:

- Applied against a scratch database restored from a production dump, verifying
  all existing rows survive with `expense_id` intact and the `CHECK` accepts
  them. This is a prerequisite for the production run, not an optional step.

Manual, against production after deploy:

- Create a PO with a receipt, confirm OCR text appears, push it, confirm the
  file is attached to the Books PO.

## Files

| File | Change |
|---|---|
| `apps/api/src/db/schema.ts` | polymorphic receipt owner + check + index |
| `apps/api/drizzle/00NN_*.sql` | generated migration |
| `apps/api/src/lib/receiptOwner.ts` | new — pure owner resolver |
| `apps/api/src/routes/receipts.ts` | owner-agnostic handlers, expense-only auto-push |
| `apps/api/src/server.ts` | second mount for transaction receipts |
| `apps/api/src/lib/zoho.ts` | `attachReceiptToBooksPurchaseOrder` client |
| `apps/api/src/lib/zohoPoPush.ts` | attach step + receipt warning + Zoho PO number write |
| `apps/api/src/lib/zohoPoPayload.ts` | populate or remove `receiptCount`; drop `poNumber` from create |
| `apps/api/src/routes/transactions.ts` | stop accepting `poNumber` on create |
| `apps/web/src/pages/PurchaseOrderNew.tsx` | remove the PO number input; add receipt upload |
| `apps/web/src/pages/PurchaseOrderDetail.tsx` | show the receipt and its OCR text |
| `apps/web/src/pages/ExpenseNew.tsx` | drop "— no receipt to scan" from the PO card |
