# Multiple images per expense and purchase order

**Date:** 2026-09-11
**Status:** Approved for planning
**Target version:** Midas `1.13.0`
**Repo:** `~/Work/midas` (only — the OCR service and the Zoho service are untouched)

---

## Problem

A user can attach exactly one photo to an expense or a purchase order. Real
receipts are frequently more than one image: a long till roll photographed in
two frames, a two-page itemized vendor invoice, a receipt plus the card slip.
Today the second photo has nowhere to go.

The ask: let a user **take or upload — or mix both — several images on one
expense or PO entry**, at creation time and afterwards.

---

## What is actually true today

The database has supported many receipts per owner since the polymorphic-owner
change. The limit is entirely in the client, plus two server assumptions.

| Layer | State | Where |
|---|---|---|
| `receipts` table | Already many-per-owner: `expense_id` XOR `transaction_id`, both indexed | `schema.ts` — `receipts` |
| `GET /:owner/:id/receipts` | Already returns a **list** | `receipts.ts:83` |
| `POST /:owner/:id/receipts` | One file per request (`upload.single`), full per-file pipeline | `receipts.ts:96` |
| `DELETE /:owner/:id/receipts/:receiptId` | Exists, submitter-only | `receipts.ts:170` |
| `ExpenseDetail` receipts card | Already `.map()`s over many | `ExpenseDetail.tsx:833` |
| `PurchaseOrderDetail` receipts card | Already `.map()`s over many | `PurchaseOrderDetail.tsx:443` |
| Every file input | No `multiple`, reads `files?.[0]` | `ExpenseNew.tsx:489,490,777,778`, `PurchaseOrderNew.tsx:384`, `ExpenseDetail.tsx:827`, `PurchaseOrderDetail.tsx:424`, `MobileNav.tsx:154` |
| `ExpenseNew` form state | `const [receipt, setReceipt] = useState<File \| null>(null)` | `ExpenseNew.tsx:38` |
| `PurchaseOrderNew` form state | Same single-`File` shape plus in-flight guards | `PurchaseOrderNew.tsx:64-83` |
| Offline queue item | One `receipt: {name,type,size,data}` per item | `uploadQueue.ts:31-37` |
| Zoho expense push | `findFirst` + `orderBy asc(uploadedAt)` — attaches **one** | `zohoPush.ts:249` |
| Zoho PO push | `findFirst` + `orderBy asc(uploadedAt)` — attaches **one** | `zohoPoPush.ts:174` |

Two consequences worth stating plainly:

1. **No schema change is needed.** `uploadedAt` ascending is already the
   established order in both push paths; that is the page order.
2. **No new upload endpoint is needed.** `POST .../receipts` already does HEIC
   conversion, storage, OCR, audit log and auto-push per file. Calling it N
   times reuses all of that. A batch endpoint would mean reimplementing it.

### The auto-push hazard this exposes

`receipts.ts:129` calls `maybeAutoPushPending(expenseId)` after **every**
successful expense receipt upload. A receipt is often the last missing piece of
a pending expense, so that call auto-approves and pushes to Zoho.

Upload three photos sequentially to a pending expense and photo 1 completes it
→ auto-approve → Zoho push. Photos 2 and 3 then land *after* the push and never
reach Zoho. This is latent today only because one photo is the maximum.

---

## Decisions

| Decision | Choice | Rejected alternative |
|---|---|---|
| Upload transport | N sequential calls to the existing single-file endpoint | New batch/multipart-array endpoint (duplicates the OCR + audit + auto-push pipeline) |
| Ordering | Existing `uploadedAt ASC` = page order | New `sort_order` column (schema change for no gain) |
| What reaches Zoho | **Merge into one PDF** when 2+ receipts | Attach primary only + flag; user-chosen primary. Both leave the Zoho record incomplete |
| Single-receipt behavior | Byte-for-byte passthrough, no PDF wrapper | Always merge (re-encodes today's working path for no benefit, widens regression surface) |
| OCR | Scan **every** image; only the **first** prefills form fields | First image only (loses searchable text on later pages); merge all OCR results (conflict rules + cost) |
| Auto-push during a batch | `?batch=1` skips the check on all but the final upload | Debounce server-side (timing-dependent, untestable) |
| Capture affordance | Shared component: thumbnail strip + `Add photo → Camera / Files` | Per-page ad-hoc inputs across four large files |
| `MobileNav` quick capture | Stays single-photo | Multi-select there too — it is a one-tap shortcut *into* the form, where the strip lives |
| Web test target | Extracted pure state module | Component tests — `apps/web` has no jsdom/testing-library harness |

---

## Component 1 — `receiptBundle.ts` (new)

`apps/api/src/lib/receiptBundle.ts`. One exported function, pure apart from
reading files from disk.

```ts
type BundleInput = { filename: string; mimeType: string; storagePath: string };

type BundleResult = {
  file: { buffer: Buffer; filename: string; mimeType: string } | null;
  /** Receipts left out because their type cannot be embedded. */
  skipped: string[];
};

export async function buildReceiptBundle(
  receipts: BundleInput[],
  uploadsDir: string,
): Promise<BundleResult>;
```

Behavior by count:

- **0 receipts** → `{ file: null, skipped: [] }`. Callers keep their existing
  "pushed with no receipt" warning path untouched.
- **1 receipt** → that file's bytes, filename and mime type verbatim. This is
  the overwhelmingly common case and must not be re-encoded.
- **2+ receipts** → a single `application/pdf` named
  `receipt-<n>-pages.pdf`, assembled with `pdf-lib` in input order:
  - `image/jpeg` → `embedJpg`, one page sized to the image.
  - `image/png` → `embedPng`, one page sized to the image.
  - `application/pdf` → `copyPages`, all pages inlined in place.
  - anything else → not embedded; its filename is added to `skipped`.
- **2+ receipts where every one is skipped** → `{ file: null, skipped: [...] }`.
  Treated by callers exactly like "no receipt".
- **2+ receipts where only one is embeddable** → still produces a one-page PDF.
  Simpler than a special case, and the `skipped` list explains the difference.

A file that cannot be read from disk throws. Callers already wrap the receipt
attach in try/catch and record `receipt file could not be read (<path>)`; that
path stays and now names the bundle.

`pdf-lib` is pure JavaScript — no native build step, so the API Dockerfile is
unchanged beyond the new dependency.

### The WebP gap, and how it is closed

`ALLOWED_MIME` in `receipts.ts:67` permits `image/webp`, and `pdf-lib` cannot
embed WebP. `compressReceiptImage` transcodes to JPEG but **skips files under
1 MB** (`receiptCompress.ts:9`), so a small WebP reaches storage as WebP.

Two-part fix:

- **Client:** in `compressReceiptImage`, the `SKIP_BELOW_BYTES` early return no
  longer applies to `image/webp` — a WebP of any size goes through the canvas
  and comes out JPEG. The existing "if the result is not smaller, keep the
  original" guard must also be bypassed for WebP, because a small WebP will
  usually grow when re-encoded as JPEG; correctness of the bundle is the point,
  not bytes saved.
- **Server:** pre-existing WebP receipts land in `skipped` and are named in the
  sync warning rather than failing the push.

---

## Component 2 — Zoho push call sites

`zohoPush.ts:249` and `zohoPoPush.ts:174` currently `findFirst` + `readFile` +
attach. Both become: `findMany` in `uploadedAt ASC` order → `buildReceiptBundle`
→ attach `result.file`.

The surrounding structure does not change. Specifically these all stay as they
are: best-effort semantics (a failed attach never fails the push), the
`receiptProblem` string, the `RECEIPT_WARNING_PREFIX` conversation message on
the expense side, `poReceiptProblem` / `poReceiptWarning` and the
`zohoSyncError` write on the PO side, and `zohoPoPush.ts:94`'s `receiptCount`.

Two additions to `receiptProblem`:

- `result.file === null` with `skipped` non-empty → `no receipt could be
  attached (unsupported file type: <names>)`.
- `result.file` present with `skipped` non-empty → the existing outcome text
  plus `; <n> receipt(s) not included: <names>`.

The `none` outcome (`zohoPoReceipt.ts:58`, "purchase order pushed with no
receipt") is reserved for a genuinely receipt-less entry and is not reused for
the all-skipped case — those are different facts and an accountant reading the
warning needs to tell them apart.

---

## Component 3 — `?batch=1` on receipt upload

`POST /:owner/:id/receipts` gains one optional query flag, parsed the same way
as the existing `async` flag (`receipts.ts:102`):

```ts
const inBatch = req.query.batch === '1' || req.query.batch === 'true';
```

When `inBatch` is true, the `autoPush` thunk at `receipts.ts:129` resolves to
`undefined` without calling `maybeAutoPushPending`. Everything else — storage,
OCR, audit log, the response shape — is identical.

The client sets `batch=1` on every upload of a multi-file batch **except the
last**, so exactly one auto-push check runs, after every image has landed.

This flag is expense-only in effect; the PO branch already passes a no-op
`autoPush`.

---

## Component 4 — `receiptBatch.ts` (new, web)

`apps/web/src/lib/receiptBatch.ts`. The strip's state machine, extracted so it
is testable without a DOM — `apps/web` has vitest but no jsdom or
testing-library, and the two existing web tests (`ocrLineItems.test.ts`,
`paymentMethodScope.test.ts`) are pure-logic.

```ts
export type BatchSlot =
  | { state: 'uploading'; localId: string; name: string; previewUrl: string | null }
  | { state: 'done'; localId: string; receipt: Receipt }
  | { state: 'failed'; localId: string; name: string; file: File; error: string };

/** What a tile renders: an attached receipt, or a local slot still resolving. */
export type DisplayItem =
  | { kind: 'attached'; receipt: Receipt }
  | { kind: 'slot'; slot: BatchSlot };

/**
 * Server receipts (uploadedAt order) followed by local slots that have not yet
 * appeared in the server list, so a tile never renders twice as an upload
 * settles and the query refetches.
 */
export function mergeSlots(serverReceipts: Receipt[], slots: BatchSlot[]): DisplayItem[];

/** true for every index except the last — drives the `batch=1` flag. */
export function isBatchedUpload(index: number, total: number): boolean;

/** Enforces MAX_RECEIPTS against what is already attached. */
export function acceptFiles(
  picked: File[],
  currentCount: number,
): { accepted: File[]; rejected: string[] };
```

`MAX_RECEIPTS = 10`. Per-file size stays at the server's existing 10 MB
(`receipts.ts:69`); the client does not duplicate that limit, it surfaces the
server's rejection.

---

## Component 5 — `ReceiptAttachments` component (new, web)

`apps/web/src/components/ReceiptAttachments.tsx`. One component, four call
sites. `ExpenseNew` is 791 lines and `ExpenseDetail` is 1058; neither should
grow another inline upload flow, and the same widget is wanted in both plus the
two PO pages.

```tsx
<ReceiptAttachments
  kind="expense" | "transaction"
  ownerId={string | null}              // null until a draft exists
  ensureOwnerId={() => Promise<string>} // creates the draft on demand
  onFirstReceipt={(r: Receipt) => void} // OCR prefill hook; fires once
  readOnly={boolean}
/>
```

Responsibilities:

- Query the owner's receipts (`['expense-receipts', id]` /
  `['transaction-receipts', id]`) when `ownerId` is set.
- Render a thumbnail strip merging server receipts with in-flight slots, in
  order, via `mergeSlots`.
- **Add photo** offers two entries — **Camera** (`capture="environment"`,
  single) and **Files** (`multiple`, `accept="image/*,.pdf,.heic,.heif"`). A
  single picker can offer the camera or the library but not both, which is why
  the mix-and-match requirement needs this affordance rather than just adding
  `multiple` to today's inputs.
- On pick: call `ensureOwnerId()` once, then upload the files **sequentially**,
  each through `compressReceiptImage`, with `batch=1` on all but the last.
  Sequential rather than parallel so `uploadedAt` ordering is deterministic and
  the single auto-push genuinely runs last.
- Per-tile state: uploading spinner, failed tile with **Retry** (re-uploads the
  retained `File`) and **Remove**. A retry is always sent **without** `batch=1`,
  whatever the file's position in the original batch — it is the last upload of
  its own batch of one, and the auto-push check must get a chance to run.
- Remove on a `done` tile calls the existing `DELETE` endpoint and invalidates
  the query.
- Fire `onFirstReceipt` exactly once — for the first receipt to upload
  successfully on an owner that had none.

`readOnly` hides every control and renders the thumbnails only. It is set from
the existing `isOwner` checks; upload and delete are submitter-only on the
server (`loadOwnerFor(..., { requireSubmitter: true })`) and this change does
not widen that.

### Call sites

| Page | `ownerId` | `ensureOwnerId` | `onFirstReceipt` |
|---|---|---|---|
| `ExpenseNew` | draft id once created | today's draft-create inside `startWithReceipt` (`ExpenseNew.tsx:232`) | `applyOcr` (`ExpenseNew.tsx:173`) |
| `PurchaseOrderNew` | draft id once created | today's draft-create inside `startWithReceipt` (`PurchaseOrderNew.tsx:112`) | PO header + line-item prefill |
| `ExpenseDetail` | `expense.id` | already exists — returns it | not used |
| `PurchaseOrderDetail` | `tx.id` | already exists — returns it | not used |

Both **New** pages keep their existing entry tiles (*Scan receipt* / *Upload
receipt*) as the way to start; those hand the first file to the component,
which then owns the strip. The single-`File` state (`receipt`, `previewUrl`,
`receiptAttached`, `uploadInFlight`, `ocrRun`, `abandonedOcr`) is removed from
both pages and replaced by the component's own state plus a boolean for "has at
least one receipt", which is what the OCR status card and the Save-path guards
actually need.

`MobileNav.tsx:154` is unchanged: one photo, routed into the form, where more
can be added.

---

## Component 6 — Offline queue

`UploadQueueItem.receipt` becomes `receipts: QueuedFile[]` (same
`{name,type,size,data}` shape). `DB_VERSION` goes 1 → 2 with an
`onupgradeneeded` migration that rewrites every existing row from `receipt` to
`[receipt]`. A phone holding an unsynced expense right now must not lose it.

- `enqueueUpload` takes `receipts: File[]`.
- `receiptFileFromQueueItem` becomes `receiptFilesFromQueueItem` → `File[]`.
- `syncOne` (`uploadQueueSync.ts:46`) uploads each file in order, `batch=1` on
  all but the last. A partial failure keeps the item queued with `expenseId`
  already recorded, as today — so a retry must skip files already uploaded.
  The item therefore also records which queued files have landed
  (`uploadedIndexes: number[]`), updated after each success.
- `ToUpload.tsx:108` shows `item.receipt.name`; it becomes the first filename
  plus `+N more` when there is more than one.

---

## Out of scope, deliberately

- **Re-attaching to an already-pushed Zoho record.** Adding a photo to an
  expense that is already in Zoho does not update the Zoho attachment today and
  will not after this change. The bundle is built at push time.
- **Concatenating OCR line items across pages.** On a multi-page PO, page 1's
  line items prefill; later pages are OCR'd and stored but their lines are
  typed in by hand. An "add lines from this page" control is a separate feature.
- **Accountants uploading receipts.** Upload and delete stay submitter-only.
- **Reordering pages.** Order is upload order. No drag-to-reorder.
- **Multi-image in the browser extension** (`extensionExpenses.ts`) and the
  `Cashbook` import (`Cashbook.tsx:519`). Both stay single-file.
- **A `sort_order` column.** `uploadedAt` is sufficient and already relied on.

---

## Failure behavior

| Failure | Result |
|---|---|
| A non-final file in a batch fails | Its tile shows `failed` with Retry. The others attach, and the final (unbatched) upload still runs the auto-push check. |
| The **final** file in a batch fails | No auto-push check runs — the request that carried it never reached the server. The expense stays pending until the user retries that tile, whose retry is unbatched and does run the check. This is strictly safer than the alternative: an expense auto-pushed while a receipt is still missing. |
| Every file in a batch fails | Owner has no receipts; existing "no receipt" warnings apply unchanged. |
| Offline mid-batch | Existing `isLikelyOfflineOrNetworkError` path queues the expense with all its files; the queue drains on reconnect. |
| `pdf-lib` throws while merging | Caught in the push path's existing try/catch → `receipt file could not be read` warning, push still succeeds. Never fails a Zoho push. |
| A receipt file is missing from disk | Same as today: caught, logged with `uploadsDir`, warning recorded. This is the outage class the `zohoPush.ts:241` comment describes and the behavior must not regress. |
| Owner already has 10 receipts | `acceptFiles` rejects the extras client-side with a named message. |

---

## Testing

**API (vitest, no DB):**

- `receiptBundle.test.ts` — 0 / 1 / many; single-receipt passthrough is
  byte-identical; JPEG + PNG + PDF mixed produces the right page count in the
  right order; WebP lands in `skipped`; all-skipped returns `file: null`;
  unreadable file throws.
- `receiptBatchFlag.test.ts` — `batch=1`, `batch=true` parse as batched;
  absent/`0` do not.
- Extend `zohoPoReceipt.test.ts` for the two new `receiptProblem` strings and
  for `none` still meaning genuinely-receipt-less.
- Existing `receiptPushBlocker.test.ts`, `zohoPoReceipt.test.ts`,
  `receiptOwner.test.ts`, `receiptImage.test.ts` must keep passing unmodified
  where they assert single-receipt behavior that is unchanged.

**Web (vitest, pure logic):**

- `receiptBatch.test.ts` — `mergeSlots` ordering with mixed server/local items;
  `isBatchedUpload` true for all but last, and for a single file returns false
  (so a lone upload still triggers auto-push, exactly as today);
  `acceptFiles` at and over the cap.
- `uploadQueue` v1→v2 migration: a v1 row with `receipt` reads back as a v2 row
  with a one-element `receipts`.

Full suite (`npm run test -w apps/api`, currently 695 passing) must be green,
plus `npm run lint` and `npm run build` at the workspace root.

---

## Versioning

`1.12.1` → **`1.13.0`**. Additive user-visible feature, no breaking API change
(`?batch=1` is optional and defaults to today's behavior).

Per `docs/VERSIONING.md`, bump in the same commit: `MIDAS_VERSION` in
`packages/shared/src/version.ts`, and `version` in `apps/api/package.json`,
`apps/web/package.json`, `packages/shared/package.json` — plus a
`docs/CHANGELOG.md` section. Tag `v1.13.0` after merge to `main`.

---

## Deployment

No DB migration — the schema is unchanged. The API image must be rebuilt for
the new `pdf-lib` dependency.

1. `tailscale up --accept-routes` and wait for routes to settle — the laptop is
   not on the server LAN.
2. Merge to `main`, push, tag `v1.13.0`.
3. Deploy to CT 3120 using **`docker-compose.prod.yml` alone** — both `api` and
   `web` build from that file; the base file or a merged pair silently
   misbuilds prod.
4. Verify `GET /api/v1/meta` reports `1.13.0`.
5. Smoke: attach two photos to a new expense, confirm both render on the detail
   page, push to Zoho, confirm the attachment in Zoho Books is a 2-page PDF.
