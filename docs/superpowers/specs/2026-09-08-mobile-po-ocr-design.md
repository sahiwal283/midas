# Mobile purchase-order capture with OCR line items

**Date:** 2026-09-08
**Status:** Approved for planning
**Target version:** Midas `1.10.0`, ocrService `0.18.0`
**Repos:** `~/Work/midas`, `~/Work/services/ocrService`

---

## Problem

Mobile users cannot create a purchase order at all.

The PO flow exists — `/transactions/po/new` (`PurchaseOrderNew.tsx`), which already
renders stacked line-item cards below `md`. The only route to it is the "Purchase
order" card on the `choose` step of `/expenses/new`, and on a phone that step is
unreachable:

- Dashboard's "Add Transaction" button is `hidden lg:inline-flex` (`Dashboard.tsx:221`)
- `MyExpenses` has no add button
- The bottom-nav camera FAB jumps straight to `/expenses/new?mode=scan`, skipping `choose`
- `MobileNav`'s "More" sheet has no transactions entry

So the feature is not missing logic. It is missing a door, and a fast path behind it.

Beyond the door, entering PO line items by hand on a phone is slow enough that the
door alone would not get used. OCR should extract the lines from the photographed
receipt so the user confirms rather than types.

---

## Constraints discovered during design

These are load-bearing. Each one changed a decision.

| Finding | Location | Consequence |
|---|---|---|
| `OcrResult.lineItems` is declared but never populated | `packages/ocr-client/src/types.ts:43` | The seam exists; the implementation does not |
| `_format_llm_fields` whitelists 8 scalar fields, discards the rest | `llm_enhancement.py:238` | Line items would be dropped even if the LLM returned them |
| `X-Workflow` reaches the job row but not the pipeline | `ocr.py:104`, `ocr_pipeline.py:80` | PO mode needs plumbing; the header already arrives |
| Prompts come from an external Model Training service, one active prompt for all callers | `prompt_service.py:90` | PO instructions cannot live in the prompt store without affecting every caller |
| Envelope parity gate does subset checks (`EXPECTED - set(keys)`) | `verify_image.py:342` | Adding a top-level key is additive-safe |
| But every `fields.*` entry must be a `{value, confidence, source}` dict | `verify_image.py:369` | Line items must be a **separate top-level key**, never inside `fields` |
| Document AI line items are raw `{text, confidence}` blobs, no qty/price split | `document_ai_processor.py:212` | Not a usable structured source; LLM path only for v1 |
| The full `OcrResult` is persisted to `receipts.ocr_data` (jsonb) | `runReceiptOcr.ts:38` | Line items are stored and readable with no migration |
| Receipt upload requires an existing owner id | `receipts.ts:96` | Nothing to OCR against until the PO exists |
| `upsertVendorByName` returns `null` on an empty name | `syncExpenseTransaction.ts:21` | A vendor-less draft is safe |
| Draft POs never reach the accountant queue | `accountant.ts:169` | Abandoned drafts are invisible to accountants |
| PO submit **approves and pushes to Zoho immediately** | `transactions.ts:414` | There is no review buffer to catch a bad line |
| Zoho push rejects any line without `zohoItemId` | `zohoPoPush.ts:87` | OCR descriptions alone cannot push |
| There is no PO list UI | `App.tsx` routes | An approved PO with a failed push is reachable only by direct URL |
| `POST /:id/ocr-line-items` has zero callers, including tests | `transactions.ts:599` | Dead "Phase 1 foundation" route |
| `apps/web` defines no `test` script | `apps/web/package.json` | Browser layer cannot be unit-tested; logic must live elsewhere |
| ocrService is LXC 204 on the same Proxmox host as Midas | `OPERATIONS_RUNBOOK.md:6` | One SSH credential covers both deploys |

Three of those rows combine into the sharpest constraint — `transactions.ts:414`,
`zohoPoPush.ts:87` and the absent PO list UI: **submit approves and pushes with no
review step, push rejects unmapped lines, and a failed push leaves an orphan nobody
can navigate to.** Auto-matched Zoho items are
exactly the input most likely to be incomplete, so this design adds validation
*before* the approve rather than relying on the push to catch it.

---

## Approach

**Draft-first.** Choosing "Purchase order" creates an empty draft PO immediately,
uploads the photo to it, and lets the existing `runReceiptOcr` path do the work.

Two alternatives were considered and rejected:

- **Stateless preview endpoint** — cleanest state model, but OCR would run twice per
  PO (preview, then the real upload), doubling phone latency and double-billing the
  service's per-job cost ledger.
- **Staged receipt table** — avoids both the draft row and the duplicate OCR, but
  costs a migration, a new object lifecycle, and a cleanup job for unclaimed files.
  The most new machinery for the smallest gain.

Draft-first adds no new persistence concept and no duplicate OCR spend, and reuses
the receipt-upload OCR path that already exists. Its cost is a transaction row that
exists before the user commits — acceptable because such drafts are invisible to
accountants and the existing cancel route hard-deletes them.

### Flow

```
photo taken
  → sheet: Expense or Purchase order?
  → POST /transactions/purchase-orders   (vendorName: '', lineItems: [])
  → POST /transactions/:id/receipts      (workflow: purchase-order)
        → runReceiptOcr → ocrService → lineItems → receipts.ocr_data
  → form prefills: vendor, date, tax, total, lines
  → matchZohoItem() preselects Zoho items client-side
  → user confirms / corrects
  → PATCH /transactions/:id
  → detail page → Submit → approve + Zoho push
```

---

## Component 1 — ocrService (`~/Work/services/ocrService`)

**Purpose:** return structured line items for purchase-order receipts.
**Interface:** `POST /ocr/` gains a top-level `line_items` array in its response.
**Depends on:** the configured LLM provider; the Model Training prompt store.

1. **Plumb the workflow.** Thread `x_workflow` through
   `run_ocr_pipeline(workflow=…)` → `extract_fields_directly(workflow=…)`. No
   behavior change when the workflow is `receipt-ocr` or absent.

2. **PO extraction prompt.** `_build_full_prompt` and `_build_minimal_prompt` append
   a locally-defined line-item instruction block, applied only when
   `workflow == 'purchase-order'`. This lives in-repo rather than in the prompt
   store because there is exactly one active prompt shared by every caller.

3. **Stop dropping line items — on a separate channel.** They must *not* join
   `_format_llm_fields`' return value: that dict becomes the response's `fields`, and
   `verify_image.py:369` requires every `fields.*` entry to be a
   `{value, confidence, source}` dict, so a `lineItems` key there fails the release
   gate. Instead add `_format_llm_line_items`, normalizing each entry to
   `{description, quantity, unit, unitPrice, tax, total, confidence}`, and a new
   `extract_fields_and_lines()` returning `(fields, line_items)`.
   `extract_fields_directly()` stays as a wrapper returning only fields, so its
   existing tests are untouched. Unparseable values become `null`; a malformed entry
   is skipped, never raised.

4. **Envelope.** Add top-level `line_items` to the pipeline response dict — a sibling
   of `fields`, not a member of it. Additive at the top level, so the frozen-envelope
   gate cannot break.

5. **Version.** `app/config.py:15` → `0.18.0`, and `EXPECTED_VERSION` in
   `scripts/verify_image.py:44` in the same commit — they are gated against each other.

**Out of scope:** structuring Document AI's raw `line_item` entity blobs. That is a
separate extraction problem; the LLM path is the single source for v1.

---

## Component 2 — `packages/ocr-client`

**Purpose:** map the service's line items onto the already-declared type.
**Interface:** `OcrResult.lineItems`, `OcrAdapter.process(path, id, opts?)`.

6. `normalizeServiceResponse` maps `line_items` → `OcrResult.lineItems` defensively:
   a non-array becomes `undefined`, malformed entries are skipped.

7. `OcrAdapter.process()` takes an optional `{ workflow }` so a caller can request PO
   mode per receipt. Today `workflow` is fixed at construction from `OCR_WORKFLOW`;
   that stays the default when no override is passed, so existing callers are unaffected.

8. `MockOcrAdapter` returns deterministic sample line items under the PO workflow, so
   the path is exercisable with `OCR_MODE=mock` in local dev and tests.

---

## Component 3 — Midas API (`apps/api`)

**Purpose:** let a PO draft exist before it has a vendor, run OCR in PO mode, and
refuse to approve a PO that cannot push.

9. **Relax draft creation.** `createPoSchema.vendorName`: `min(1)` → `z.string().default('')`.
   `upsertVendorByName` already no-ops on empty, so no blank vendor rows are created.
   Everything else about `POST /transactions/purchase-orders` is unchanged — it
   already accepts `lineItems: []`.

10. **Two new submit gates** in `POST /:id/submit`, both evaluated *before* the status
    flips to `approved`:
    - empty `vendorName` → `409 MISSING_VENDOR`
    - when the company has Zoho enabled: a missing `zohoVendorId`, or any line
      missing `zohoItemId` → `409`

    This is a deliberate behavior change. Submit currently approves and then pushes;
    a push rejected for an unmapped line leaves an `approved` PO that, with no PO list
    UI, cannot be found again. Validating first turns an unrecoverable state into a
    correctable form error. The gates must **not** fire when the company has Zoho
    disabled, since no push will occur.

11. **OCR in PO mode.** `runReceiptOcr(receiptId, storagePath, opts?)` gains an
    optional workflow. `receipts.ts` passes `'purchase-order'` when
    `owner.kind !== 'expense'`, alongside the auto-push branch that already exists at
    `receipts.ts:128`.

12. **No new read endpoint.** The upload response already returns the updated receipt
    row including `ocrData`; the client reads `receipt.ocrData.lineItems` from it.

13. **Confirm-save uses `PATCH /transactions/:id`.** `updatePoSchema` already accepts
    `vendorName`, `transactionDate`, `zohoEntity`, `taxTotal` and `lineItems` — the
    whole confirm payload in one call. Move the "clear `receipts.ocrNeedsReview`"
    behavior into this path when `lineItems` are supplied.

14. **Delete `POST /:id/ocr-line-items`.** Zero callers, including tests. PATCH now
    covers it, and keeping both would leave two routes owning line-item writes with
    subtly different side effects.

---

## Component 4 — `packages/shared`

**Purpose:** decide which Zoho catalogue item an OCR description refers to.
**Interface:** `matchZohoItem(description, items) → { item, score } | null`.
**Depends on:** nothing. Pure function.

15. Normalized token overlap against item name and SKU, returning the best candidate
    with its score. Runs client-side over the catalogue the form already fetches from
    `/transactions/meta/items` — no new endpoint, no extra round trip. Living in
    `shared` keeps it unit-testable and available to the API if server-side matching
    is ever wanted.

Threshold: at or above `0.6` preselects the item; below leaves the line unmapped.

---

## Component 5 — Web (`apps/web`)

### Mobile entry

16. `MobileNav`'s camera FAB currently hard-routes to `/expenses/new?mode=scan`. After
    the photo it instead opens a bottom sheet — *"What is this receipt?"* →
    **Expense** / **Purchase order** — routing via the existing `pendingCapture`
    handoff either way. Expense keeps today's behavior exactly. Purchase order goes to
    `/transactions/po/new?mode=scan`. The sheet renders above the nav bar; backdrop
    tap dismisses to Expense, so the common case costs one extra tap at most.

### `PurchaseOrderNew`

17. On a picked receipt — the `?mode=scan` handoff on mobile, or the existing file
    input on desktop — create the draft, upload the compressed photo, and wait on the
    sync OCR response. While waiting, show the receipt thumbnail with
    *"Reading the receipt…"* and an **Enter manually** escape hatch: sync OCR on a
    phone network is the slowest step and must never be a dead end. Taking the escape
    hatch stops waiting on the response and reveals the empty form; the draft and its
    uploaded receipt are kept, and a late OCR result is discarded rather than
    overwriting anything the user has since typed.

    The draft is created **only when a receipt is picked**. Opening the form and
    filling it in without a receipt behaves exactly as today: nothing is created until
    Save.

18. On success, prefill vendor, date, tax and total, and populate the lines.

19. Hold the draft id in component state so a retaken photo reuses the same draft
    rather than creating a second one. Cancel calls the existing `POST /:id/cancel`,
    which for an owner's unsynced draft returns `hard_delete` — removing the row and
    the stored file.

**Accepted change to desktop:** picking a receipt now creates the draft immediately,
where today the file is held until Save. This is the cost of a single shared flow, and
it is visible on a form accountants already use.

### `<LineItemReview>` (new, shared by create and detail)

20. Table at `md+`, stacked cards below. Per line: description, qty, unit, price, tax,
    total, and the Zoho item picker carrying its match state:
    - matched at or above threshold → preselected, showing matched item name and score
    - below threshold → empty, flagged **pick an item**
    - OCR line confidence `< 0.7` → amber **verify**, matching the existing 0.7
      convention in `PurchaseOrderDetail`

### Mobile optimization

21. `inputMode="decimal"` on qty, price, tax and tax-total. These are plain text
    inputs today, so phones open the alphabetic keyboard for numeric entry — the
    single biggest friction in the current form.
22. Sticky bottom action bar for Save / Cancel, above the fixed nav (`Layout` already
    reserves `pb-20`).
23. Confirmed lines collapse to one-line summaries, expanding on tap, so a 12-line PO
    is not an endless scroll.
24. Receipt thumbnail pinned to the header, so the user can check what they
    photographed while confirming.
25. A clear notice when any line still lacks a Zoho item, since submit now blocks on
    exactly that.

---

## Failure behavior

| Failure | Behavior |
|---|---|
| OCR service down or timing out | `runReceiptOcr` catches and writes `ocrStatus: 'failed'` (`runReceiptOcr.ts:52`); upload still succeeds, receipt still attached, form falls back to manual entry |
| LLM returns malformed line entries | Skipped during normalization; the rest of the response is unaffected |
| LLM returns no line items | Form shows one blank line, as today |
| `/transactions/meta/items` fails | Existing amber catalogue warning; matcher returns no matches, every line shows **pick an item** |
| Draft created but upload fails | Draft survives with the form intact; the receipt can be retried from the same screen |
| User abandons the draft | Invisible to accountants; hard-deleted by Cancel, including the stored file |

---

## Testing

`apps/web` has no test runner, so the browser layer is covered by `tsc --noEmit` and
manual verification. The real logic is deliberately pushed into testable places.

**`packages/shared`** — `matchZohoItem`: exact match, SKU hit, near-miss above
threshold, junk below threshold, empty catalogue.

**`apps/api`** — vendor-less draft creation; both submit gates, including that they do
*not* fire when the company has Zoho disabled; PATCH clearing `ocrNeedsReview`; the PO
workflow reaching the adapter; the removed route returning 404.

**`packages/ocr-client`** — `line_items` mapping present / absent / malformed;
`MockOcrAdapter` PO output.

**`ocrService`** — pytest over line-item normalization and workflow plumbing, then
`scripts/verify_image.py` as the release gate.

The full suite (578+ tests) runs, not just the new files, with actual output reported.

---

## Versioning

Midas `1.9.0 → 1.10.0` — MINOR, per `docs/VERSIONING.md`: new user-visible feature and
changed API behavior. Bump `MIDAS_VERSION` (`packages/shared/src/version.ts`) plus
`apps/api`, `apps/web` and `packages/shared` `package.json`, and add a
`docs/CHANGELOG.md` entry.

ocrService `0.17.0 → 0.18.0` in `app/config.py:15`, with `EXPECTED_VERSION` in
`scripts/verify_image.py:44` bumped in the same commit.

---

## Deployment

ocrService first, so `lineItems` exists before Midas asks for it. The change is
additive, so the reverse order degrades to today's behavior rather than breaking.

1. **ocrService → LXC 204** (`ssh root@192.168.1.190`, then `pct exec 204`). Code
   reaches the container through a bind mount of `/opt/ocr-build/app`, *not* the image
   layer — the deploy replaces files there and restarts. Preserve `Privileged: true`;
   the runbook flags it as easy to lose. Gate with
   `verify_image.py http://192.168.1.195:8000`.
2. **Midas → `192.168.1.190`.** No migration in this change, which sidesteps the
   known-broken migrator service. Build from `docker-compose.prod.yml` — both api and
   web build from that file alone; the base or merged files silently break prod.
3. Verify `GET /api/v1/meta` returns `1.10.0`, then walk the flow on a real phone.

No new environment variables are introduced, so prod `.env` is untouched.

Two things to confirm at deploy time rather than assume:

- that the LLM provider returns usable line items on a real PO receipt — the prompt
  change is the one part no unit test can prove
- that the deployed `.env` is unchanged by the release
