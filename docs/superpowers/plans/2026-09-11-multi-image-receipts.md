# Multiple Images Per Expense and Purchase Order — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user attach several images — camera, file picker, or a mix — to one expense or purchase order, at creation time and afterwards, with all of them reaching Zoho Books as a single merged PDF.

**Architecture:** The `receipts` table has always been many-per-owner, so nothing changes in the schema and no new upload endpoint is added — the client calls the existing single-file `POST .../receipts` N times in sequence. Two server changes make that safe: a new `receiptBundle.ts` merges 2+ receipts into one PDF at Zoho-push time (Zoho Books holds one attachment per record), and a new `?batch=1` query flag defers the auto-approve/auto-push check to the last upload of a batch so a half-uploaded expense cannot push early. On the web side, one shared `ReceiptAttachments` component replaces five ad-hoc single-file inputs, with its state machine extracted into a pure module because `apps/web` has no DOM test harness.

**Tech Stack:** TypeScript, Node/Express, Drizzle ORM, PostgreSQL, React 18 + TanStack Query, Vite, Tailwind, vitest, `pdf-lib` (new), multer, Docker.

**Spec:** `docs/superpowers/specs/2026-09-11-multi-image-receipts-design.md`

## Global Constraints

- **Target version: `1.13.0`** (from `1.12.1`). Bump `MIDAS_VERSION` in `packages/shared/src/version.ts` plus `version` in `apps/api/package.json`, `apps/web/package.json`, `packages/shared/package.json` — all four must agree (`docs/VERSIONING.md`).
- **No database migration.** `apps/api/src/db/schema.ts` is not edited by any task in this plan.
- **No new API endpoint.** The only server-side API surface change is one optional query flag, `?batch=1`, on the existing `POST /:owner/:id/receipts`.
- **Receipt ordering is `uploadedAt ASC`, with `id ASC` as tiebreaker.** That is page order. Both Zoho push paths already order this way.
- **`MAX_RECEIPTS = 10`** per expense or purchase order. Per-file size stays at the server's existing `MAX_SIZE = 10 * 1024 * 1024` (`apps/api/src/routes/receipts.ts:69`); the client does not re-implement that limit.
- **Upload and delete stay submitter-only** on the server (`loadOwnerFor(..., { requireSubmitter: true })`). No task widens this.
- **A failed Zoho receipt attach must never fail a Zoho push.** Re-pushing duplicates the record in Zoho Books. Every new code path inside a push stays inside the existing try/catch structure.
- **`pdf-lib` is the only new runtime dependency.** It must be pure JavaScript — no native build step, so the API Dockerfile is unchanged.
- **`apps/web` has no jsdom or testing-library.** Web tests are pure-logic `.test.ts` files colocated beside the module under test (see `apps/web/src/lib/ocrLineItems.test.ts`). Do not write React component tests; extract logic instead.

---

### Task 1: `receiptBundle.ts` — merge receipts into one PDF

**Files:**
- Modify: `apps/api/package.json` (add `pdf-lib` dependency)
- Create: `apps/api/src/lib/receiptBundle.ts`
- Test: `apps/api/src/__tests__/receiptBundle.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type BundleInput = { filename: string; mimeType: string; storagePath: string }`
  - `type BundleFile = { buffer: Buffer; filename: string; mimeType: string }`
  - `type BundleResult = { file: BundleFile | null; skipped: string[] }`
  - `function classifyReceipts(receipts: BundleInput[]): { embeddable: BundleInput[]; skipped: string[] }`
  - `async function buildReceiptBundle(receipts: BundleInput[], uploadsDir: string): Promise<BundleResult>`

  Tasks 2 and 3 call `buildReceiptBundle` only.

- [ ] **Step 1: Install the dependency**

```bash
npm install pdf-lib@^1.17.1 -w apps/api
```

- [ ] **Step 2: Verify it is pure JS (no native build)**

```bash
ls node_modules/pdf-lib/package.json && ! ls node_modules/pdf-lib/binding.gyp 2>/dev/null && echo "pure JS — Dockerfile unchanged"
```

Expected: prints the path then `pure JS — Dockerfile unchanged`. If a `binding.gyp` exists, stop and report — the Global Constraints forbid a native dependency here.

- [ ] **Step 3: Write the failing test**

Create `apps/api/src/__tests__/receiptBundle.test.ts`:

```ts
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReceiptBundle, classifyReceipts } from '../lib/receiptBundle';

// A 1x1 transparent PNG. Any real PNG works; this one keeps the test hermetic.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

// A 1x1 JPEG. If pdf-lib rejects this constant, replace it with the bytes of
// any real .jpg — the point of the assertion is the mime dispatch, not this
// particular fixture.
const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

let dir: string;

/** Write `bytes` into the fake uploads dir and return a BundleInput for it. */
async function put(name: string, mimeType: string, bytes: Buffer) {
  await fs.writeFile(path.join(dir, name), bytes);
  return { filename: name, mimeType, storagePath: name };
}

/** A real 2-page PDF, built with the same library that has to read it back. */
async function twoPagePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'midas-bundle-'));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('classifyReceipts', () => {
  it('accepts jpeg, png and pdf', () => {
    const input = [
      { filename: 'a.jpg', mimeType: 'image/jpeg', storagePath: 'a.jpg' },
      { filename: 'b.png', mimeType: 'image/png', storagePath: 'b.png' },
      { filename: 'c.pdf', mimeType: 'application/pdf', storagePath: 'c.pdf' },
    ];
    const { embeddable, skipped } = classifyReceipts(input);
    expect(embeddable).toHaveLength(3);
    expect(skipped).toEqual([]);
  });

  it('skips webp, which pdf-lib cannot embed', () => {
    const { embeddable, skipped } = classifyReceipts([
      { filename: 'a.jpg', mimeType: 'image/jpeg', storagePath: 'a.jpg' },
      { filename: 'old.webp', mimeType: 'image/webp', storagePath: 'old.webp' },
    ]);
    expect(embeddable.map((r) => r.filename)).toEqual(['a.jpg']);
    expect(skipped).toEqual(['old.webp']);
  });

  it('matches the mime type case-insensitively', () => {
    const { embeddable } = classifyReceipts([
      { filename: 'a.JPG', mimeType: 'IMAGE/JPEG', storagePath: 'a.JPG' },
    ]);
    expect(embeddable).toHaveLength(1);
  });
});

describe('buildReceiptBundle', () => {
  it('returns no file for no receipts', async () => {
    expect(await buildReceiptBundle([], dir)).toEqual({ file: null, skipped: [] });
  });

  it('passes a single receipt through byte-for-byte', async () => {
    const only = await put('single.png', 'image/png', PNG_1X1);
    const { file, skipped } = await buildReceiptBundle([only], dir);
    expect(skipped).toEqual([]);
    expect(file!.filename).toBe('single.png');
    expect(file!.mimeType).toBe('image/png');
    expect(file!.buffer.equals(PNG_1X1)).toBe(true);
  });

  it('passes a single PDF through without rewrapping it', async () => {
    const pdf = await twoPagePdf();
    const only = await put('single.pdf', 'application/pdf', pdf);
    const { file } = await buildReceiptBundle([only], dir);
    expect(file!.mimeType).toBe('application/pdf');
    expect(file!.buffer.equals(pdf)).toBe(true);
  });

  it('merges two images into a two-page PDF', async () => {
    const a = await put('one.png', 'image/png', PNG_1X1);
    const b = await put('two.png', 'image/png', PNG_1X1);
    const { file, skipped } = await buildReceiptBundle([a, b], dir);
    expect(skipped).toEqual([]);
    expect(file!.mimeType).toBe('application/pdf');
    expect(file!.filename).toBe('receipt-2-pages.pdf');
    const out = await PDFDocument.load(file!.buffer);
    expect(out.getPageCount()).toBe(2);
  });

  it('embeds a jpeg alongside a png', async () => {
    const a = await put('photo.jpg', 'image/jpeg', JPEG_1X1);
    const b = await put('scan.png', 'image/png', PNG_1X1);
    const { file } = await buildReceiptBundle([a, b], dir);
    const out = await PDFDocument.load(file!.buffer);
    expect(out.getPageCount()).toBe(2);
  });

  it('inlines the pages of an existing PDF in order', async () => {
    const a = await put('img.png', 'image/png', PNG_1X1);
    const b = await put('doc.pdf', 'application/pdf', await twoPagePdf());
    const { file } = await buildReceiptBundle([a, b], dir);
    const out = await PDFDocument.load(file!.buffer);
    // 1 image page + 2 copied PDF pages
    expect(out.getPageCount()).toBe(3);
    expect(file!.filename).toBe('receipt-3-pages.pdf');
  });

  it('names skipped receipts but still bundles the rest', async () => {
    const a = await put('good.png', 'image/png', PNG_1X1);
    const b = await put('bad.webp', 'image/webp', Buffer.from('not really webp'));
    const c = await put('also-good.png', 'image/png', PNG_1X1);
    const { file, skipped } = await buildReceiptBundle([a, b, c], dir);
    expect(skipped).toEqual(['bad.webp']);
    const out = await PDFDocument.load(file!.buffer);
    expect(out.getPageCount()).toBe(2);
  });

  it('returns no file when every receipt is unembeddable', async () => {
    const a = await put('x.webp', 'image/webp', Buffer.from('x'));
    const b = await put('y.webp', 'image/webp', Buffer.from('y'));
    const { file, skipped } = await buildReceiptBundle([a, b], dir);
    expect(file).toBeNull();
    expect(skipped).toEqual(['x.webp', 'y.webp']);
  });

  it('throws when a receipt file is missing from disk', async () => {
    const ghost = { filename: 'gone.png', mimeType: 'image/png', storagePath: 'gone.png' };
    await expect(buildReceiptBundle([ghost], dir)).rejects.toThrow();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
npm run test -w apps/api -- receiptBundle
```

Expected: FAIL — `Failed to resolve import "../lib/receiptBundle"`.

- [ ] **Step 5: Write the implementation**

Create `apps/api/src/lib/receiptBundle.ts`:

```ts
/**
 * Zoho Books holds ONE attachment per expense and per purchase order — a
 * second attach replaces the first. Midas allows many receipts per record, so
 * everything the user attached is merged into a single PDF at push time and
 * that PDF is what Zoho receives.
 *
 * A lone receipt is passed through untouched. Re-wrapping the overwhelmingly
 * common case in a PDF would re-encode a working path for no benefit, and
 * would change what accountants have been seeing in Zoho for every
 * single-receipt expense ever pushed.
 */

import fs from 'fs/promises';
import path from 'path';
import { PDFDocument } from 'pdf-lib';

export type BundleInput = {
  filename: string;
  mimeType: string;
  storagePath: string;
};

export type BundleFile = {
  buffer: Buffer;
  filename: string;
  mimeType: string;
};

export type BundleResult = {
  file: BundleFile | null;
  /** Filenames left out because pdf-lib cannot embed their type. */
  skipped: string[];
};

/**
 * pdf-lib embeds JPEG and PNG only, and copies pages out of an existing PDF.
 * `image/webp` is in the upload allow-list (`receipts.ts` ALLOWED_MIME) and is
 * NOT embeddable — the client transcodes new WebP uploads to JPEG, but
 * receipts already in storage from before that change still exist.
 */
const EMBEDDABLE = new Set(['image/jpeg', 'image/png', 'application/pdf']);

/** Split receipts into what can go into a PDF and what cannot. Pure. */
export function classifyReceipts(
  receipts: BundleInput[],
): { embeddable: BundleInput[]; skipped: string[] } {
  const embeddable: BundleInput[] = [];
  const skipped: string[] = [];
  for (const r of receipts) {
    if (EMBEDDABLE.has(r.mimeType.toLowerCase())) embeddable.push(r);
    else skipped.push(r.filename);
  }
  return { embeddable, skipped };
}

/**
 * Build the single file to hand to Zoho.
 *
 * Throws if a receipt file cannot be read from disk. Both callers already run
 * inside a try/catch that records `receipt file could not be read (<path>)`
 * and lets the push stand — that is the outage class from v1.3.2, where a
 * changed uploads mount made every readFile throw while pushes still reported
 * success. Do not swallow it here.
 */
export async function buildReceiptBundle(
  receipts: BundleInput[],
  uploadsDir: string,
): Promise<BundleResult> {
  if (receipts.length === 0) return { file: null, skipped: [] };

  const read = (r: BundleInput) => fs.readFile(path.join(uploadsDir, r.storagePath));

  // One receipt: verbatim bytes, verbatim name and type. No re-encode.
  if (receipts.length === 1) {
    const only = receipts[0];
    return {
      file: { buffer: await read(only), filename: only.filename, mimeType: only.mimeType },
      skipped: [],
    };
  }

  const { embeddable, skipped } = classifyReceipts(receipts);
  if (embeddable.length === 0) return { file: null, skipped };

  const doc = await PDFDocument.create();
  for (const r of embeddable) {
    const bytes = await read(r);
    const mime = r.mimeType.toLowerCase();

    if (mime === 'application/pdf') {
      // ignoreEncryption: a password-protected receipt should contribute its
      // pages rather than throw away the whole bundle.
      const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const pages = await doc.copyPages(src, src.getPageIndices());
      for (const p of pages) doc.addPage(p);
      continue;
    }

    const image = mime === 'image/png'
      ? await doc.embedPng(bytes)
      : await doc.embedJpg(bytes);
    // One page per photo, sized to the photo, so nothing is cropped or letterboxed.
    const page = doc.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }

  const merged = Buffer.from(await doc.save());
  return {
    file: {
      buffer: merged,
      filename: `receipt-${doc.getPageCount()}-pages.pdf`,
      mimeType: 'application/pdf',
    },
    skipped,
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
npm run test -w apps/api -- receiptBundle
```

Expected: PASS, all 12 tests.

If the `embeds a jpeg alongside a png` test fails with a pdf-lib decode error, the `JPEG_1X1` constant is bad — replace it with the base64 of any real `.jpg` file and re-run. Do not delete the test.

- [ ] **Step 7: Run the full API suite to check nothing regressed**

```bash
npm run test -w apps/api
```

Expected: PASS. Baseline before this plan is 695 tests in 68 files; this task adds 12.

- [ ] **Step 8: Commit**

```bash
git add apps/api/package.json package-lock.json apps/api/src/lib/receiptBundle.ts apps/api/src/__tests__/receiptBundle.test.ts
git commit -m "feat(api): merge multiple receipts into one PDF for Zoho"
```

---

### Task 2: Attach the bundle on the expense Zoho push

**Files:**
- Modify: `apps/api/src/lib/zohoPush.ts:249-276`
- Test: `apps/api/src/__tests__/receiptBundleWarning.test.ts` (create)

**Interfaces:**
- Consumes: `buildReceiptBundle`, `BundleResult` from Task 1.
- Produces: `function bundleReceiptProblem(result: BundleResult, attached: boolean): string | null` exported from `apps/api/src/lib/receiptBundle.ts` — Task 3 reuses it.

Context: `zohoPush.ts` currently does `db.query.receipts.findFirst` and attaches that one file. The surrounding structure — best-effort semantics, the `receiptProblem` string, the `RECEIPT_WARNING_PREFIX` conversation warning, the outer try/catch that keeps a successful push from being marked failed — does not change.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/__tests__/receiptBundleWarning.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { bundleReceiptProblem } from '../lib/receiptBundle';

const file = { buffer: Buffer.from('x'), filename: 'receipt-2-pages.pdf', mimeType: 'application/pdf' };

describe('bundleReceiptProblem', () => {
  it('is null when the bundle attached cleanly', () => {
    expect(bundleReceiptProblem({ file, skipped: [] }, true)).toBeNull();
  });

  it('reports a Zoho rejection', () => {
    expect(bundleReceiptProblem({ file, skipped: [] }, false))
      .toBe('Zoho rejected the receipt upload');
  });

  it('names receipts left out of a bundle that did attach', () => {
    expect(bundleReceiptProblem({ file, skipped: ['old.webp'] }, true))
      .toBe('1 receipt not included in the attachment: old.webp');
  });

  it('pluralises and lists every excluded receipt', () => {
    expect(bundleReceiptProblem({ file, skipped: ['a.webp', 'b.webp'] }, true))
      .toBe('2 receipts not included in the attachment: a.webp, b.webp');
  });

  it('keeps the rejection when some receipts were also excluded', () => {
    expect(bundleReceiptProblem({ file, skipped: ['a.webp'] }, false))
      .toBe('Zoho rejected the receipt upload; 1 receipt not included in the attachment: a.webp');
  });

  it('distinguishes "nothing could be attached" from "there was no receipt"', () => {
    // file: null WITH skipped entries means receipts exist but none are
    // embeddable. That is a different fact from a receipt-less record, and an
    // accountant reading the warning has to be able to tell them apart.
    expect(bundleReceiptProblem({ file: null, skipped: ['a.webp'] }, false))
      .toBe('no receipt could be attached (unsupported file type: a.webp)');
  });

  it('is null for a genuinely receipt-less record', () => {
    // The caller decides what a receipt-less record means — on the expense side
    // nothing is warned, on the PO side poReceiptProblem({kind:'none'}) is used.
    expect(bundleReceiptProblem({ file: null, skipped: [] }, false)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test -w apps/api -- receiptBundleWarning
```

Expected: FAIL — `bundleReceiptProblem is not a function` / no exported member.

- [ ] **Step 3: Add `bundleReceiptProblem` to `receiptBundle.ts`**

Append to `apps/api/src/lib/receiptBundle.ts`:

```ts
/**
 * Warning text for what became of the bundle, or null when there is nothing to
 * warn about. Pure, so the rules are covered without a database or a Zoho
 * client.
 *
 * `{ file: null, skipped: [] }` returns null on purpose: that is a genuinely
 * receipt-less record, and what it means is the caller's decision — the
 * expense side says nothing, the PO side flags it via
 * `poReceiptProblem({ kind: 'none' })`.
 */
export function bundleReceiptProblem(
  result: BundleResult,
  attached: boolean,
): string | null {
  if (!result.file) {
    if (result.skipped.length === 0) return null;
    return `no receipt could be attached (unsupported file type: ${result.skipped.join(', ')})`;
  }

  const parts: string[] = [];
  if (!attached) parts.push('Zoho rejected the receipt upload');
  if (result.skipped.length > 0) {
    const noun = result.skipped.length === 1 ? 'receipt' : 'receipts';
    parts.push(
      `${result.skipped.length} ${noun} not included in the attachment: ${result.skipped.join(', ')}`,
    );
  }
  return parts.length ? parts.join('; ') : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test -w apps/api -- receiptBundleWarning
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Wire the bundle into the expense push**

In `apps/api/src/lib/zohoPush.ts`, add to the imports near the other `./` imports:

```ts
import { buildReceiptBundle, bundleReceiptProblem } from './receiptBundle';
```

Then replace the block that currently starts `const receipt = await db.query.receipts.findFirst({` and ends at the closing brace of `if (receipt) { ... }` (around lines 249-276) with:

```ts
        // Every receipt on the expense, in page order, merged into one file.
        // Zoho Books holds a single attachment per expense, so a second attach
        // would replace the first rather than add to it.
        const rows = await db.query.receipts.findMany({
          where: eq(receipts.expenseId, expense.id),
          orderBy: [asc(receipts.uploadedAt), asc(receipts.id)],
        });
        if (rows.length > 0) {
          let bundle: Awaited<ReturnType<typeof buildReceiptBundle>> | null = null;
          try {
            bundle = await buildReceiptBundle(rows, env.UPLOADS_DIR);
          } catch (err) {
            receiptProblem = `receipt file could not be read (${rows.map((r) => r.storagePath).join(', ')})`;
            logger.error(
              { err, expenseId: expense.id, storagePaths: rows.map((r) => r.storagePath), uploadsDir: env.UPLOADS_DIR },
              'Receipt unreadable — expense pushed to Zoho without its receipt',
            );
          }

          if (bundle) {
            if (bundle.file) {
              try {
                receiptAttached = await attachReceiptToBooksExpense(
                  result.zohoExpenseId,
                  bundle.file,
                  payload.brand,
                );
              } catch (err) {
                logger.error(
                  { err, expenseId: expense.id },
                  'Zoho receipt attach threw — expense pushed without its receipt',
                );
              }
            }
            receiptProblem = bundleReceiptProblem(bundle, receiptAttached);
          }

          if (receiptProblem && !receiptAttached) {
            logger.warn(
              { expenseId: expense.id, zohoExpenseId: result.zohoExpenseId, reason: receiptProblem },
              'Zoho expense created without a receipt attachment',
            );
          }
        }
```

Three details that must hold:
- `attachReceiptToBooksExpense` takes `{ buffer, filename, mimeType }`, which is exactly the shape of `bundle.file` — pass it directly.
- `receiptAttached` and `receiptProblem` are the same `let` declarations already above this block. Do not redeclare them.
- The `if (receiptProblem)` block below (the one writing `zohoSyncError` with `RECEIPT_WARNING_PREFIX`) is unchanged.

- [ ] **Step 6: Type-check and run the full API suite**

```bash
npm run lint -w apps/api && npm run test -w apps/api
```

Expected: both PASS. `receiptPushBlocker.test.ts`, `zohoService.test.ts` and `zohoReadiness.test.ts` must still pass untouched.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/receiptBundle.ts apps/api/src/lib/zohoPush.ts apps/api/src/__tests__/receiptBundleWarning.test.ts
git commit -m "feat(api): push every expense receipt to Zoho as one merged PDF"
```

---

### Task 3: Attach the bundle on the purchase-order Zoho push

**Files:**
- Modify: `apps/api/src/lib/zohoPoPush.ts:172-205`
- Modify: `apps/api/src/lib/zohoPoReceipt.ts` (extend `PoReceiptOutcome`)
- Test: `apps/api/src/__tests__/zohoPoReceipt.test.ts` (extend)

**Interfaces:**
- Consumes: `buildReceiptBundle`, `bundleReceiptProblem` from Tasks 1-2.
- Produces: `PoReceiptOutcome` gains a `{ kind: 'bundled'; problem: string | null }` variant. Nothing after this task depends on it.

Context: the PO path differs from the expense path in one way that matters — a receipt-less PO is *flagged*, not silent (`poReceiptProblem({ kind: 'none' })` → `'purchase order pushed with no receipt'`). That rule must survive, and must stay distinct from "receipts exist but none could be attached".

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/__tests__/zohoPoReceipt.test.ts`:

```ts
describe('poReceiptProblem — bundled outcomes', () => {
  it('is null when the bundle attached cleanly', () => {
    expect(poReceiptProblem({ kind: 'bundled', problem: null })).toBeNull();
  });

  it('passes the bundle problem through verbatim', () => {
    expect(poReceiptProblem({
      kind: 'bundled',
      problem: '1 receipt not included in the attachment: old.webp',
    })).toBe('1 receipt not included in the attachment: old.webp');
  });

  it('still distinguishes a receipt-less PO from an unattachable one', () => {
    expect(poReceiptProblem({ kind: 'none' }))
      .toBe('purchase order pushed with no receipt');
    expect(poReceiptProblem({
      kind: 'bundled',
      problem: 'no receipt could be attached (unsupported file type: a.webp)',
    })).toBe('no receipt could be attached (unsupported file type: a.webp)');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test -w apps/api -- zohoPoReceipt
```

Expected: FAIL — a TypeScript error that `'bundled'` is not assignable to `PoReceiptOutcome`.

- [ ] **Step 3: Extend the outcome type**

In `apps/api/src/lib/zohoPoReceipt.ts`, add the variant to `PoReceiptOutcome`:

```ts
export type PoReceiptOutcome =
  | { kind: 'attached' }
  | { kind: 'none' }
  | { kind: 'rejected' }
  | { kind: 'unreadable'; storagePath: string }
  /**
   * A multi-receipt PO whose bundle was assembled. The problem text (or null)
   * comes from `bundleReceiptProblem` in receiptBundle.ts, which already knows
   * how to describe a rejection and any receipts left out of the merge. Kept
   * separate from 'none' so "there was no receipt" and "there were receipts but
   * none could be attached" stay legible as different facts.
   */
  | { kind: 'bundled'; problem: string | null };
```

And add the case to `poReceiptProblem`:

```ts
    case 'bundled':
      return outcome.problem;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test -w apps/api -- zohoPoReceipt
```

Expected: PASS.

- [ ] **Step 5: Wire the bundle into the PO push**

In `apps/api/src/lib/zohoPoPush.ts`, add to the imports:

```ts
import { buildReceiptBundle, bundleReceiptProblem } from './receiptBundle';
```

Replace the block from `const receipt = await db.query.receipts.findFirst({` through the end of the `else { ... }` that assigns `outcome` (around lines 174-204) with:

```ts
        const rows = await db.query.receipts.findMany({
          where: eq(receipts.transactionId, tx.id),
          orderBy: [asc(receipts.uploadedAt), asc(receipts.id)],
        });

        let outcome: PoReceiptOutcome;
        if (rows.length === 0) {
          // Spec Decision 6: a receipt-less PO pushes and is *flagged*. Not a
          // hard gate — blocking would strand every PO already in flight
          // without one — but it must not render as a clean "Created" either.
          outcome = { kind: 'none' };
        } else {
          try {
            const bundle = await buildReceiptBundle(rows, env.UPLOADS_DIR);
            let attached = false;
            if (bundle.file) {
              attached = await attachReceiptToBooksPurchaseOrder(
                result.zohoPurchaseOrderId,
                bundle.file,
                resolveBrandFromEntity(tx.zohoEntity) ?? env.ZOHO_DEFAULT_BRAND,
              );
            }
            outcome = attached && bundle.skipped.length === 0
              ? { kind: 'attached' }
              : { kind: 'bundled', problem: bundleReceiptProblem(bundle, attached) };
          } catch (err) {
            outcome = { kind: 'unreadable', storagePath: rows.map((r) => r.storagePath).join(', ') };
            logger.error(
              { err, transactionId: tx.id, storagePaths: rows.map((r) => r.storagePath), uploadsDir: env.UPLOADS_DIR },
              'Receipt unreadable — purchase order pushed to Zoho without its receipt',
            );
          }
        }
```

Everything after this — `receiptAttached = outcome.kind === 'attached'`, `receiptProblem = poReceiptProblem(outcome)`, the `zohoSyncError` write, the outer catch, the audit log — is unchanged.

Note `receiptAttached` stays `outcome.kind === 'attached'`, so a bundle that attached but left a WebP out is reported as not-cleanly-attached in the audit metadata. That is correct: something the user attached did not reach Zoho.

`zohoPoPush.ts:94`'s `receiptCount` is already a `db.$count` over all receipts and needs no change.

- [ ] **Step 6: Type-check and run the full API suite**

```bash
npm run lint -w apps/api && npm run test -w apps/api
```

Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/zohoPoPush.ts apps/api/src/lib/zohoPoReceipt.ts apps/api/src/__tests__/zohoPoReceipt.test.ts
git commit -m "feat(api): push every PO receipt to Zoho as one merged PDF"
```

---

### Task 4: `?batch=1` — defer auto-push to the last upload

**Files:**
- Create: `apps/api/src/lib/batchFlag.ts`
- Modify: `apps/api/src/routes/receipts.ts:96-147`
- Test: `apps/api/src/__tests__/batchFlag.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `function isBatchedUpload(raw: unknown): boolean` — Task 5's web client mirrors this contract but does not import it (different workspace).

Why this exists: `receipts.ts:129` calls `maybeAutoPushPending` after *every* successful expense receipt upload, and a receipt is often the last missing piece of a pending expense. Uploading three photos sequentially means photo 1 completes the expense → auto-approve → Zoho push, and photos 2 and 3 land after the push and never reach Zoho. The client sets `batch=1` on all but the final upload so exactly one auto-push check runs, after every image has landed.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/__tests__/batchFlag.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isBatchedUpload } from '../lib/batchFlag';

describe('isBatchedUpload', () => {
  it('treats "1" and "true" as batched, matching the async flag', () => {
    expect(isBatchedUpload('1')).toBe(true);
    expect(isBatchedUpload('true')).toBe(true);
  });

  it('defaults to not-batched when the flag is absent', () => {
    // The default must preserve today's behaviour exactly: a lone upload runs
    // the auto-push check. Every existing caller omits this parameter.
    expect(isBatchedUpload(undefined)).toBe(false);
  });

  it('is not batched for explicit falsey values', () => {
    expect(isBatchedUpload('0')).toBe(false);
    expect(isBatchedUpload('false')).toBe(false);
    expect(isBatchedUpload('')).toBe(false);
  });

  it('ignores values it does not recognise rather than guessing', () => {
    expect(isBatchedUpload('yes')).toBe(false);
    expect(isBatchedUpload(['1'])).toBe(false);
    expect(isBatchedUpload(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test -w apps/api -- batchFlag
```

Expected: FAIL — cannot resolve `../lib/batchFlag`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/lib/batchFlag.ts`:

```ts
/**
 * `?batch=1` on a receipt upload means "more files are coming — do not run the
 * auto-approve/auto-push check yet".
 *
 * Without it, uploading several photos to a pending expense pushes to Zoho as
 * soon as the first one completes the expense, and the remaining photos land
 * after the push and never reach Zoho. The client sets the flag on every
 * upload of a batch except the last.
 *
 * Absent means false, so every existing caller keeps today's behaviour.
 * Parsed as a pure function so the condition is covered without a request.
 */
export function isBatchedUpload(raw: unknown): boolean {
  return raw === '1' || raw === 'true';
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test -w apps/api -- batchFlag
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Use the flag in the upload route**

In `apps/api/src/routes/receipts.ts`, add to the imports:

```ts
import { isBatchedUpload } from '../lib/batchFlag';
```

Find this block (around line 127):

```ts
  const autoPush = owner.kind === 'expense'
    ? () => maybeAutoPushPending(owner.id, req.user!.id)
    : async () => undefined;
```

Replace it with:

```ts
  // More files are still coming in this batch: hold the auto-approve/auto-push
  // check until the last one lands, or the expense pushes to Zoho with only
  // the first photo attached.
  const inBatch = isBatchedUpload(req.query.batch);
  const autoPush = owner.kind === 'expense' && !inBatch
    ? () => maybeAutoPushPending(owner.id, req.user!.id)
    : async () => undefined;
```

Nothing else in the route changes — storage, OCR, the audit log and both response shapes are identical.

- [ ] **Step 6: Type-check and run the full API suite**

```bash
npm run lint -w apps/api && npm run test -w apps/api
```

Expected: both PASS. `pendingCompletion.test.ts` must still pass — the default path is unchanged.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/batchFlag.ts apps/api/src/routes/receipts.ts apps/api/src/__tests__/batchFlag.test.ts
git commit -m "feat(api): defer auto-push to the last upload of a receipt batch"
```

---

### Task 5: Web plumbing — batch state module, API client, WebP transcode

**Files:**
- Create: `apps/web/src/lib/receiptBatch.ts`
- Create: `apps/web/src/lib/receiptBatch.test.ts`
- Modify: `apps/web/src/api/expenses.ts:123-134` and `:146-158`
- Modify: `apps/web/src/lib/receiptCompress.ts:14,38`
- Create: `apps/web/src/lib/receiptCompress.test.ts`

**Interfaces:**
- Consumes: `Receipt` from `../types`, `?batch=1` from Task 4.
- Produces:
  - `const MAX_RECEIPTS = 10`
  - `type BatchSlot` (union below)
  - `type DisplayItem = { kind: 'attached'; receipt: Receipt } | { kind: 'slot'; slot: BatchSlot }`
  - `function isBatchedUpload(index: number, total: number): boolean`
  - `function acceptFiles(picked: File[], currentCount: number): { accepted: File[]; rejected: string[] }`
  - `function mergeSlots(serverReceipts: Receipt[], slots: BatchSlot[]): DisplayItem[]`
  - `function shouldTranscode(type: string, size: number): boolean` from `receiptCompress.ts`
  - `expenseApi.listReceipts(expenseId)`, and a third `opts` argument on both upload functions.

  Task 6 consumes all of these.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/receiptBatch.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Receipt } from '../types';
import { MAX_RECEIPTS, acceptFiles, isBatchedUpload, mergeSlots, type BatchSlot } from './receiptBatch';

function receipt(id: string, filename = `${id}.jpg`): Receipt {
  return { id, filename } as Receipt;
}

function file(name: string): File {
  return new File(['x'], name, { type: 'image/jpeg' });
}

describe('isBatchedUpload', () => {
  it('batches every upload except the last', () => {
    expect(isBatchedUpload(0, 3)).toBe(true);
    expect(isBatchedUpload(1, 3)).toBe(true);
    expect(isBatchedUpload(2, 3)).toBe(false);
  });

  it('does not batch a lone upload, so auto-push still runs as it does today', () => {
    expect(isBatchedUpload(0, 1)).toBe(false);
  });
});

describe('acceptFiles', () => {
  it('accepts everything when well under the cap', () => {
    const { accepted, rejected } = acceptFiles([file('a.jpg'), file('b.jpg')], 0);
    expect(accepted).toHaveLength(2);
    expect(rejected).toEqual([]);
  });

  it('accepts up to the cap and names what it turned away', () => {
    const picked = Array.from({ length: 4 }, (_, i) => file(`p${i}.jpg`));
    const { accepted, rejected } = acceptFiles(picked, MAX_RECEIPTS - 2);
    expect(accepted.map((f) => f.name)).toEqual(['p0.jpg', 'p1.jpg']);
    expect(rejected).toEqual(['p2.jpg', 'p3.jpg']);
  });

  it('accepts nothing once the cap is already reached', () => {
    const { accepted, rejected } = acceptFiles([file('a.jpg')], MAX_RECEIPTS);
    expect(accepted).toEqual([]);
    expect(rejected).toEqual(['a.jpg']);
  });
});

describe('mergeSlots', () => {
  const uploading: BatchSlot = { state: 'uploading', localId: 'L1', name: 'new.jpg', previewUrl: null };
  const failed: BatchSlot = {
    state: 'failed', localId: 'L2', name: 'bad.jpg', file: file('bad.jpg'), error: 'Upload failed',
  };

  it('puts server receipts first, in the order given', () => {
    const items = mergeSlots([receipt('r1'), receipt('r2')], []);
    expect(items).toEqual([
      { kind: 'attached', receipt: receipt('r1') },
      { kind: 'attached', receipt: receipt('r2') },
    ]);
  });

  it('appends unresolved slots after the attached receipts', () => {
    const items = mergeSlots([receipt('r1')], [uploading, failed]);
    expect(items.map((i) => i.kind)).toEqual(['attached', 'slot', 'slot']);
  });

  it('drops a done slot whose receipt is already in the server list', () => {
    // Otherwise the tile renders twice for the moment between the upload
    // resolving and the receipts query refetching.
    const done: BatchSlot = { state: 'done', localId: 'L3', receipt: receipt('r1') };
    const items = mergeSlots([receipt('r1')], [done]);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ kind: 'attached', receipt: receipt('r1') });
  });

  it('keeps a done slot the server list has not caught up with yet', () => {
    const done: BatchSlot = { state: 'done', localId: 'L3', receipt: receipt('r9') };
    const items = mergeSlots([receipt('r1')], [done]);
    expect(items).toHaveLength(2);
    expect(items[1]).toEqual({ kind: 'slot', slot: done });
  });
});
```

Create `apps/web/src/lib/receiptCompress.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { shouldTranscode } from './receiptCompress';

const MB = 1_000_000;

describe('shouldTranscode', () => {
  it('leaves a small jpeg alone — it is already small and already embeddable', () => {
    expect(shouldTranscode('image/jpeg', 0.4 * MB)).toBe(false);
  });

  it('shrinks a large jpeg', () => {
    expect(shouldTranscode('image/jpeg', 4 * MB)).toBe(true);
  });

  it('always transcodes webp, whatever its size', () => {
    // pdf-lib cannot embed WebP, so a WebP receipt would be dropped from the
    // merged PDF that reaches Zoho. Correctness of the bundle beats bytes saved.
    expect(shouldTranscode('image/webp', 0.1 * MB)).toBe(true);
    expect(shouldTranscode('image/webp', 4 * MB)).toBe(true);
  });

  it('never touches PDFs or HEIC — the server converts HEIC itself', () => {
    expect(shouldTranscode('application/pdf', 8 * MB)).toBe(false);
    expect(shouldTranscode('image/heic', 8 * MB)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test -w apps/web
```

Expected: FAIL — cannot resolve `./receiptBatch`, and `shouldTranscode` is not exported.

- [ ] **Step 3: Write `receiptBatch.ts`**

Create `apps/web/src/lib/receiptBatch.ts`:

```ts
/**
 * State for the receipt strip: what the server already has, plus the files
 * still on the wire. Extracted from the component because `apps/web` has no
 * DOM test harness — this is the part worth testing.
 */

import type { Receipt } from '../types';

/** Per-entry cap. The server's own 10 MB per-file limit is not duplicated here. */
export const MAX_RECEIPTS = 10;

export type BatchSlot =
  | { state: 'uploading'; localId: string; name: string; previewUrl: string | null }
  | { state: 'done'; localId: string; receipt: Receipt }
  | { state: 'failed'; localId: string; name: string; file: File; error: string };

/** What one tile renders. */
export type DisplayItem =
  | { kind: 'attached'; receipt: Receipt }
  | { kind: 'slot'; slot: BatchSlot };

/**
 * True for every upload in a batch except the last, which is what the API's
 * `?batch=1` flag means. A lone upload returns false, so the auto-push check
 * still runs exactly as it does today.
 *
 * A retry never goes through this — it is the last upload of its own batch of
 * one, so it must be unbatched and give auto-push a chance to run.
 */
export function isBatchedUpload(index: number, total: number): boolean {
  return index < total - 1;
}

/** Trim a pick down to what still fits, naming whatever was turned away. */
export function acceptFiles(
  picked: File[],
  currentCount: number,
): { accepted: File[]; rejected: string[] } {
  const room = Math.max(0, MAX_RECEIPTS - currentCount);
  return {
    accepted: picked.slice(0, room),
    rejected: picked.slice(room).map((f) => f.name),
  };
}

/**
 * Server receipts in their given order, then any slot the server list has not
 * caught up with. A `done` slot whose receipt is already in the server list is
 * dropped — without that, the tile renders twice for the window between an
 * upload resolving and the receipts query refetching.
 */
export function mergeSlots(serverReceipts: Receipt[], slots: BatchSlot[]): DisplayItem[] {
  const known = new Set(serverReceipts.map((r) => r.id));
  const items: DisplayItem[] = serverReceipts.map((receipt) => ({ kind: 'attached', receipt }));
  for (const slot of slots) {
    if (slot.state === 'done' && known.has(slot.receipt.id)) continue;
    items.push({ kind: 'slot', slot });
  }
  return items;
}
```

- [ ] **Step 4: Extract `shouldTranscode` in `receiptCompress.ts`**

In `apps/web/src/lib/receiptCompress.ts`, add above `compressReceiptImage`:

```ts
/**
 * Whether this file should go through the canvas re-encode.
 *
 * WebP is the special case: pdf-lib cannot embed it, so a WebP receipt would
 * be silently dropped from the merged PDF that reaches Zoho. Transcode it at
 * any size — correctness of what the accountant sees beats the bytes saved.
 */
export function shouldTranscode(type: string, size: number): boolean {
  if (!COMPRESSIBLE.has(type)) return false;
  if (type === 'image/webp') return true;
  return size >= SKIP_BELOW_BYTES;
}
```

Replace the early return on line 14:

```ts
  if (!shouldTranscode(file.type, file.size)) return file;
```

And replace the "not smaller, keep the original" guard (line 38) so a WebP still converts:

```ts
    // A small WebP usually GROWS as JPEG. Keep it anyway — an unembeddable
    // receipt costs more than a few kilobytes.
    if (!blob || (blob.size >= file.size && file.type !== 'image/webp')) return file;
```

- [ ] **Step 5: Add the batch option and the expense receipt list to the API client**

In `apps/web/src/api/expenses.ts`, replace `uploadReceipt` and add `listReceipts` in `expenseApi`:

```ts
  listReceipts: (expenseId: string) =>
    client.get<{ receipts: Receipt[] }>(`/expenses/${expenseId}/receipts`)
      .then((r) => r.data.receipts),

  uploadReceipt: (expenseId: string, file: File, opts?: { batch?: boolean }) => {
    const form = new FormData();
    form.append('file', file);
    // batch=1 holds the auto-approve/auto-push check until the last file of a
    // multi-photo upload has landed.
    const qs = opts?.batch ? '?batch=1' : '';
    // Default path is sync OCR — response includes ocrStatus done/failed.
    return client.post<{ receipt: Receipt; ocrMode?: 'sync' | 'async' }>(`/expenses/${expenseId}/receipts${qs}`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 130_000,
    }).then((r) => r.data.receipt);
  },
```

And in `transactionReceiptApi`:

```ts
  upload: (transactionId: string, file: File, opts?: { batch?: boolean }) => {
    const form = new FormData();
    form.append('file', file);
    const qs = opts?.batch ? '?batch=1' : '';
    return client.post<{ receipt: Receipt; ocrMode: string }>(
      `/transactions/${transactionId}/receipts${qs}`,
      form,
    ).then((r) => r.data);
  },

  delete: (transactionId: string, receiptId: string) =>
    client.delete(`/transactions/${transactionId}/receipts/${receiptId}`).then((r) => r.data),
```

The `opts` argument is optional, so every existing call site keeps compiling and behaving identically.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm run test -w apps/web && npm run lint -w apps/web
```

Expected: both PASS — 13 new tests plus the 2 existing web test files.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/receiptBatch.ts apps/web/src/lib/receiptBatch.test.ts apps/web/src/lib/receiptCompress.ts apps/web/src/lib/receiptCompress.test.ts apps/web/src/api/expenses.ts
git commit -m "feat(web): batch upload state, receipt list API, webp transcode"
```

---

### Task 6: The `ReceiptAttachments` component

**Files:**
- Create: `apps/web/src/components/ReceiptAttachments.tsx`

**Interfaces:**
- Consumes: everything from Task 5, plus `ReceiptPreview` from `./ReceiptPreview` and `compressReceiptImage` from `../lib/receiptCompress`.
- Produces: the default-exported `ReceiptAttachments` component with this exact prop shape, which Tasks 7 and 8 render:

```ts
type Props = {
  kind: 'expense' | 'transaction';
  ownerId: string | null;
  ensureOwnerId: () => Promise<string>;
  onFirstReceipt?: (receipt: Receipt) => void;
  onChange?: () => void;
  readOnly?: boolean;
};
```

This task has no test — it is a React component in a workspace with no DOM harness, and its logic lives in `receiptBatch.ts` (tested in Task 5). Verification is a type-check plus a manual smoke in Task 7.

- [ ] **Step 1: Write the component**

Create `apps/web/src/components/ReceiptAttachments.tsx`:

```tsx
import { useRef, useState, type ChangeEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Paperclip, Upload, X, RotateCw } from 'lucide-react';
import { expenseApi, transactionReceiptApi } from '../api/expenses';
import { compressReceiptImage } from '../lib/receiptCompress';
import {
  MAX_RECEIPTS, acceptFiles, isBatchedUpload, mergeSlots, type BatchSlot,
} from '../lib/receiptBatch';
import { ReceiptPreview } from './ReceiptPreview';
import type { Receipt } from '../types';

type Props = {
  kind: 'expense' | 'transaction';
  /** null until a draft exists — `ensureOwnerId` creates one on first pick. */
  ownerId: string | null;
  ensureOwnerId: () => Promise<string>;
  /** Fires once, for the first receipt to land on an owner that had none. */
  onFirstReceipt?: (receipt: Receipt) => void;
  /** Anything that has to refetch beyond the receipts list (expense flags). */
  onChange?: () => void;
  readOnly?: boolean;
};

function apiMessage(err: unknown): string | undefined {
  return (err as { response?: { data?: { error?: { message?: string } } } })
    ?.response?.data?.error?.message;
}

function uploadMessage(err: unknown): string {
  if ((err as { response?: { status?: number } })?.response?.status === 413) {
    return 'That photo is too large (max 10 MB). Retake it or pick a smaller image.';
  }
  return apiMessage(err) ?? 'Upload failed. Tap retry.';
}

export function ReceiptAttachments({
  kind, ownerId, ensureOwnerId, onFirstReceipt, onChange, readOnly = false,
}: Props) {
  const qc = useQueryClient();
  const [slots, setSlots] = useState<BatchSlot[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  // Guards onFirstReceipt against firing twice when two picks race.
  const firstFired = useRef(false);

  const queryKey = kind === 'expense'
    ? ['expense-receipts', ownerId]
    : ['transaction-receipts', ownerId];

  const receiptsQ = useQuery({
    queryKey,
    queryFn: () => (kind === 'expense'
      ? expenseApi.listReceipts(ownerId!)
      : transactionReceiptApi.list(ownerId!)),
    enabled: !!ownerId,
  });

  const serverReceipts = receiptsQ.data ?? [];
  const items = mergeSlots(serverReceipts, slots);
  const count = items.length;

  function refresh() {
    void qc.invalidateQueries({ queryKey });
    onChange?.();
  }

  async function uploadOne(id: string, file: File, batch: boolean): Promise<Receipt> {
    const compressed = await compressReceiptImage(file);
    if (kind === 'expense') {
      return expenseApi.uploadReceipt(id, compressed, { batch });
    }
    const { receipt } = await transactionReceiptApi.upload(id, compressed, { batch });
    return receipt;
  }

  /**
   * Uploads run SEQUENTIALLY, not in parallel: `uploadedAt` decides page order
   * in the merged PDF that reaches Zoho, and the single unbatched upload has to
   * genuinely be the last one so the auto-push check sees every receipt.
   */
  async function addFiles(picked: File[]) {
    setNotice(null);
    const { accepted, rejected } = acceptFiles(picked, count);
    if (rejected.length) {
      setNotice(`Only ${MAX_RECEIPTS} images per entry — not added: ${rejected.join(', ')}`);
    }
    if (!accepted.length) return;

    const staged: BatchSlot[] = accepted.map((file, i) => ({
      state: 'uploading',
      localId: `${Date.now()}-${i}-${file.name}`,
      name: file.name,
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
    }));
    setSlots((prev) => [...prev, ...staged]);

    /** Mark one staged slot failed, keeping its File so Retry can resend it. */
    const fail = (localId: string, file: File, name: string, error: string) =>
      setSlots((prev) => prev.map((s) => (
        s.localId === localId ? { state: 'failed', localId, name, file, error } : s
      )));

    let id: string;
    try {
      id = await ensureOwnerId();
    } catch (err) {
      const message = apiMessage(err) ?? 'Could not start this entry. Please try again.';
      staged.forEach((slot, i) => fail(slot.localId, accepted[i], slot.name, message));
      return;
    }

    const hadNone = serverReceipts.length === 0;
    for (let i = 0; i < accepted.length; i += 1) {
      const slot = staged[i];
      try {
        const receipt = await uploadOne(id, accepted[i], isBatchedUpload(i, accepted.length));
        setSlots((prev) => prev.map((s) => (
          s.localId === slot.localId ? { state: 'done', localId: s.localId, receipt } : s
        )));
        if (hadNone && i === 0 && !firstFired.current) {
          firstFired.current = true;
          onFirstReceipt?.(receipt);
        }
      } catch (err) {
        fail(slot.localId, accepted[i], slot.name, uploadMessage(err));
      }
    }
    refresh();
  }

  /** A retry is the last upload of its own batch of one — never batched. */
  async function retry(slot: Extract<BatchSlot, { state: 'failed' }>) {
    if (!ownerId) return;
    setSlots((prev) => prev.map((s) => (
      s.localId === slot.localId
        ? { state: 'uploading', localId: s.localId, name: slot.name, previewUrl: null }
        : s
    )));
    try {
      const receipt = await uploadOne(ownerId, slot.file, false);
      setSlots((prev) => prev.map((s) => (
        s.localId === slot.localId ? { state: 'done', localId: s.localId, receipt } : s
      )));
      refresh();
    } catch (err) {
      setSlots((prev) => prev.map((s) => (
        s.localId === slot.localId
          ? { state: 'failed', localId: s.localId, name: slot.name, file: slot.file, error: uploadMessage(err) }
          : s
      )));
    }
  }

  async function removeReceipt(receiptId: string) {
    if (!ownerId) return;
    setNotice(null);
    try {
      if (kind === 'expense') await expenseApi.deleteReceipt(ownerId, receiptId);
      else await transactionReceiptApi.delete(ownerId, receiptId);
      setSlots((prev) => prev.filter((s) => !(s.state === 'done' && s.receipt.id === receiptId)));
      refresh();
    } catch (err) {
      setNotice(apiMessage(err) ?? 'Could not remove that receipt.');
    }
  }

  function handlePick(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (picked.length) void addFiles(picked);
  }

  const full = count >= MAX_RECEIPTS;

  return (
    <div>
      {!readOnly && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={full}
            onClick={() => cameraRef.current?.click()}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-ink/15 bg-white px-3 py-1.5 text-xs font-medium text-ink hover:bg-ink/[0.03] disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-0"
          >
            <Camera className="h-3.5 w-3.5" /> Take photo
          </button>
          <button
            type="button"
            disabled={full}
            onClick={() => filesRef.current?.click()}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-ink/15 bg-white px-3 py-1.5 text-xs font-medium text-ink hover:bg-ink/[0.03] disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-0"
          >
            <Upload className="h-3.5 w-3.5" /> Upload files
          </button>
          <span className="text-xs text-charcoal/40">{count} of {MAX_RECEIPTS}</span>

          {/* One input per entry point on purpose: a single picker offers the
              camera OR the library, never both, so mixing a photo with a file
              needs two. `multiple` only on the file picker — the camera
              returns one shot at a time. */}
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handlePick} />
          <input ref={filesRef} type="file" accept="image/*,.pdf,.heic,.heif" multiple className="hidden" onChange={handlePick} />
        </div>
      )}

      {notice && (
        <p role="alert" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {notice}
        </p>
      )}

      {items.length === 0 ? (
        <p className="text-sm text-charcoal/40">
          No receipts attached.{!readOnly && ' Take a photo or upload files above — you can add several.'}
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            item.kind === 'attached' ? (
              <div key={item.receipt.id} className="space-y-2 rounded-lg border border-ink/5 bg-cream px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <Paperclip className="h-4 w-4 shrink-0 text-charcoal/40" />
                  <span className="flex-1 truncate text-sm text-charcoal/80">{item.receipt.filename}</span>
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => void removeReceipt(item.receipt.id)}
                      aria-label={`Remove ${item.receipt.filename}`}
                      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg p-2 text-charcoal/40 hover:bg-brand-50 hover:text-danger lg:min-h-0 lg:min-w-0"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <ReceiptPreview expenseId={ownerId ?? ''} receipt={item.receipt} className="max-h-64" />
              </div>
            ) : (
              <div key={item.slot.localId} className="rounded-lg border border-ink/5 bg-cream px-3 py-2.5">
                {item.slot.state === 'uploading' && (
                  <div className="flex items-center gap-2">
                    <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
                    <span className="flex-1 truncate text-sm text-charcoal/70">{item.slot.name}</span>
                    <span className="text-xs text-charcoal/40">Uploading…</span>
                  </div>
                )}
                {item.slot.state === 'done' && (
                  <div className="flex items-center gap-2">
                    <Paperclip className="h-4 w-4 shrink-0 text-charcoal/40" />
                    <span className="flex-1 truncate text-sm text-charcoal/80">{item.slot.receipt.filename}</span>
                  </div>
                )}
                {item.slot.state === 'failed' && (
                  <div className="flex items-center gap-2">
                    <span className="flex-1 min-w-0">
                      <span className="block truncate text-sm text-charcoal/80">{item.slot.name}</span>
                      <span className="block text-xs text-danger">{item.slot.error}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => void retry(item.slot as Extract<BatchSlot, { state: 'failed' }>)}
                      className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-ink/15 bg-white px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-ink/[0.03] lg:min-h-0"
                    >
                      <RotateCw className="h-3.5 w-3.5" /> Retry
                    </button>
                    <button
                      type="button"
                      onClick={() => setSlots((prev) => prev.filter((s) => s.localId !== item.slot.localId))}
                      aria-label={`Discard ${item.slot.name}`}
                      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg p-2 text-charcoal/40 hover:bg-brand-50 hover:text-danger lg:min-h-0 lg:min-w-0"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            )
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
npm run lint -w apps/web
```

Expected: PASS, no errors. If `ReceiptPreview` complains about `className`, check it accepts the prop — it does (`ReceiptPreview.tsx`), and `className` replaces the default height cap rather than stacking with it.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ReceiptAttachments.tsx
git commit -m "feat(web): shared multi-receipt attachment strip"
```

---

### Task 7: Use the component on both detail pages

**Files:**
- Modify: `apps/web/src/pages/ExpenseDetail.tsx:547-553,586-590,818-878`
- Modify: `apps/web/src/pages/PurchaseOrderDetail.tsx:140-166,413-473`

**Interfaces:**
- Consumes: `ReceiptAttachments` from Task 6.
- Produces: nothing.

These are the simplest call sites — `ownerId` always exists, so `ensureOwnerId` just returns it, and neither page uses `onFirstReceipt`.

**Preserve the existing permission gating exactly.** `ExpenseDetail` renders its Upload control for `isOwner || isPrivileged` even though the server is submitter-only, so a privileged non-owner gets a 403 on click. That mismatch is pre-existing; do not fix it here and do not narrow it either. Pass `readOnly={!(isOwner || isPrivileged)}`. `PurchaseOrderDetail` gates on `isOwner` alone — keep that.

- [ ] **Step 1: Replace the receipts card in `ExpenseDetail.tsx`**

Delete `uploadMutation` (lines 547-553) and `handleFileChange` (lines 586-590). Then replace the entire `{/* Receipts */}` block (lines 818-878) with:

```tsx
          {/* Receipts */}
          <div id="receipts" className="scroll-mt-6 rounded-xl border border-ink/10 bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-charcoal/80">Receipts</h2>
            <ReceiptAttachments
              kind="expense"
              ownerId={expense.id}
              ensureOwnerId={async () => expense.id}
              readOnly={!(isOwner || isPrivileged)}
              onChange={() => {
                setReceiptUploadFailed(false);
                void qc.invalidateQueries({ queryKey: ['expense', id] });
              }}
            />
          </div>
```

Add the import:

```tsx
import { ReceiptAttachments } from '../components/ReceiptAttachments';
```

The accountant-only OCR diagnostics (provider, confidence, review reasons) that lived in this block are dropped from the detail page — they were never part of the upload flow and the strip is now shared with pages that must not show them. If that readout is wanted back, it belongs behind an `isPrivileged` prop on the component; note it and move on rather than growing this task.

Remove any now-unused imports (`Upload`, `Paperclip`, `compressReceiptImage`, `ChangeEvent`) only if nothing else in the file uses them — `npm run lint -w apps/web` will say.

- [ ] **Step 2: Replace the receipts card in `PurchaseOrderDetail.tsx`**

Delete `receiptsQ` (lines 140-144), `uploadReceipt` (146-160) and `handleReceiptFile` (162-166). Replace the `{/* Receipts */}` block (lines 413-473) with:

```tsx
      {/* Receipts */}
      <div className="mb-8 rounded-xl border border-ink/10 bg-white p-5 shadow-panel">
        <h2 className="mb-3 text-sm font-semibold text-charcoal/80">Receipts</h2>
        {carriedUploadError && (
          <p role="alert" className="mb-3 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">
            {carriedUploadError}
          </p>
        )}
        <ReceiptAttachments
          kind="transaction"
          ownerId={tx.id}
          ensureOwnerId={async () => tx.id}
          readOnly={!isOwner}
        />
      </div>
```

Add the import, and delete the now-unused `uploadError` state and `setUploadError` calls.

- [ ] **Step 3: Type-check and build**

```bash
npm run lint -w apps/web && npm run build -w apps/web
```

Expected: both PASS.

- [ ] **Step 4: Manual smoke test**

Start the stack and exercise the real flow — this is the first task whose output a user can see, and there is no DOM test harness to catch a broken render.

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build
```

Log in as `user@midas.local` / `user123`, open an existing expense, and confirm:
1. **Take photo** and **Upload files** both appear; the file picker allows multi-select.
2. Picking three images uploads them one at a time, each tile going spinner → filename.
3. All three render with previews after the list refetches, no duplicate tiles.
4. **Remove** on one deletes it and the count drops.
5. The same on a purchase order detail page.

Report anything that does not match before continuing.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/ExpenseDetail.tsx apps/web/src/pages/PurchaseOrderDetail.tsx
git commit -m "feat(web): multi-receipt strip on the expense and PO detail pages"
```

---

### Task 8: Use the component on both creation forms

**Files:**
- Modify: `apps/web/src/pages/ExpenseNew.tsx:38,75-76,131-137,231-280,489-490,503-570,777-778`
- Modify: `apps/web/src/pages/PurchaseOrderNew.tsx:64-83,108-181,196-204,237-256,381-396`

**Interfaces:**
- Consumes: `ReceiptAttachments` from Task 6.
- Produces: nothing.

These are the hard call sites. Both forms hold a single `File` and create the draft on first pick; the component takes that over. `ensureOwnerId` is where the draft-create moves to, and `onFirstReceipt` is where OCR prefill hooks in.

- [ ] **Step 1: Rework `ExpenseNew.tsx`**

Remove: `receipt` state (line 38), `fileInputRef`/`cameraInputRef` (75-76), the `previewUrl` effect (131-137), `startWithReceipt` and `handleFile` (231-280), and all four hidden `<input type="file">` elements (489-490, 777-778).

Add in their place:

```tsx
  // The strip owns the files now; the form only needs to know whether any
  // landed, for the OCR status card and the submit-path messaging.
  const [hasReceipt, setHasReceipt] = useState(false);
  const [expenseId, setExpenseId] = useState<string | null>(null);

  /** The strip needs an owner to attach to, so the draft is created here. */
  async function ensureExpenseId(): Promise<string> {
    if (expenseId) return expenseId;
    const expense = await expenseApi.create({ draft: true });
    setExpenseId(expense.id);
    return expense.id;
  }
```

(`expenseId` already exists in this file — keep the existing declaration and only add `hasReceipt` and `ensureExpenseId`.)

Replace the receipt summary card and the "No receipt attached yet" block (lines 503-570) with:

```tsx
        <div className="mt-4 rounded-xl border border-ink/10 bg-white p-4 shadow-panel">
          <h2 className="mb-3 text-sm font-semibold text-charcoal/80">Receipts</h2>
          {ocrRan && (
            <div className="mb-3">
              <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
                <Sparkles className="h-4 w-4 text-brand-600" />
                Check what we read — correct anything that looks off.
              </p>
              {lowConfidenceFields.size > 0 && (
                <p className="mt-1 flex items-start gap-1.5 text-xs text-amber-800">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Low confidence on {Array.from(lowConfidenceFields).join(', ')} — please double-check those fields.
                </p>
              )}
            </div>
          )}
          <ReceiptAttachments
            kind="expense"
            ownerId={expenseId}
            ensureOwnerId={ensureExpenseId}
            onFirstReceipt={(r) => { setHasReceipt(true); applyOcr(r); }}
            onChange={() => setHasReceipt(true)}
          />
        </div>
```

On the two **entry tiles** at lines 435 and 449 (`Scan receipt` / `Upload receipt`), change both `onClick` handlers to `() => setStep('form')`. The tiles now just advance to the form, where the strip is waiting — they no longer open a picker themselves. Update the second tile's copy from "From your camera roll or files (photos, HEIC, PDF)" to "Add one or several — photos, HEIC or PDF".

The `?mode=scan` handoff (lines 113-127) calls `startWithReceipt(captured)`, which no longer exists. Replace that effect body with:

```tsx
    const captured = takePendingCapture();
    if (!captured) return;
    consumedCapture.current = true;
    setStep('form');
    // The strip takes it from here: create the draft, upload, run OCR prefill.
    void (async () => {
      const id = await ensureExpenseId();
      const uploaded = await expenseApi.uploadReceipt(id, await compressReceiptImage(captured));
      setHasReceipt(true);
      applyOcr(uploaded);
    })().catch(() => setError('We could not upload that photo. Add it again below.'));
```

Delete the `setTimeout(() => cameraInputRef.current?.click(), 150)` line — there is no ref to click any more.

The offline `enqueueUpload` path that lived inside `startWithReceipt` is gone from this page; Task 9 rebuilds queueing around the multi-file shape. Between this task and that one, an offline pick fails with a visible error instead of queueing. Note it in the commit message.

- [ ] **Step 2: Rework `PurchaseOrderNew.tsx`**

Remove: `receipt`, `receiptAttached`, `uploadInFlight`, `ocrRun`, `abandonedOcr`, `previewUrl` state (lines 64-83), `startWithReceipt` (108-181), and the `previewUrl` effect (196-204).

Add:

```tsx
  async function ensureDraftId(): Promise<string> {
    if (draftId) return draftId;
    const { data } = await api.post<{ transaction: Transaction }>('/transactions/purchase-orders', {
      vendorName: '',
      transactionDate,
      lineItems: [],
    });
    setDraftId(data.transaction.id);
    return data.transaction.id;
  }

  /** OCR prefill from the first receipt: header fields, then line items. */
  async function applyPoOcr(uploaded: Receipt) {
    setOcrPhase('working');
    try {
      const header = poHeaderFromOcr(uploaded.ocrData);
      if (header.vendorName) setVendorName(header.vendorName);
      if (header.transactionDate) setTransactionDate(header.transactionDate);
      if (header.taxTotal) setTaxTotal(header.taxTotal);
      const catalogue = zohoEntity
        ? await queryClient.ensureQueryData(itemsQueryOptions(zohoEntity)).catch(() => [] as ZohoItem[])
        : [];
      const drafts = lineDraftsFromOcr(uploaded.ocrData, catalogue);
      if (drafts.length) setLines(drafts);
      setOcrPhase('done');
    } catch {
      setOcrPhase('failed');
      setError('The receipt could not be read. Enter the details by hand — the photo is saved.');
    }
  }
```

Replace the `<label>` wrapping the file input (lines 381-396) with:

```tsx
        <div className="block text-sm sm:col-span-2">
          <span className="text-charcoal/80">Receipts</span>
          <div className="mt-1">
            <ReceiptAttachments
              kind="transaction"
              ownerId={draftId}
              ensureOwnerId={ensureDraftId}
              onFirstReceipt={(r) => void applyPoOcr(r)}
            />
          </div>
        </div>
```

In the save mutation (lines 237-256), the whole "did the receipt land, upload it now if not" block goes away — every photo is already attached to the draft by the time Save runs. Replace that section with a plain `return { tx, receiptError: null }` after the create/patch, and simplify `onSuccess` to `navigate(\`/transactions/${tx.id}\`)`.

Keep the `ocrPhase` status card (lines 295+) but drop its `previewUrl` image — the strip shows the thumbnails now.

The `?mode=scan` handoff needs the same treatment as `ExpenseNew`: `ensureDraftId()`, upload, then `applyPoOcr`.

- [ ] **Step 3: Type-check and build**

```bash
npm run lint -w apps/web && npm run build -w apps/web
```

Expected: both PASS. Expect to chase unused imports (`Camera`, `Upload`, `X`, `FileText`, `compressReceiptImage`, `ChangeEvent`) — remove only those the type-checker actually flags.

- [ ] **Step 4: Manual smoke test**

With the stack running, as `user@midas.local`:
1. **New Expense → Scan receipt** → the form opens with an empty strip.
2. Take a photo → a draft is created, the photo uploads, OCR prefills merchant/amount/date, and the "Check what we read" banner appears.
3. Add two more via **Upload files** → both attach; the form fields do **not** change (first wins).
4. Submit → the expense has three receipts on its detail page.
5. **New Purchase Order** → pick a multi-line receipt → vendor and line items prefill; add a second image; Save; the PO detail page lists both.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/ExpenseNew.tsx apps/web/src/pages/PurchaseOrderNew.tsx
git commit -m "feat(web): multi-receipt strip on the expense and PO creation forms

Offline queueing on ExpenseNew is temporarily unavailable — the queue is
rebuilt for multiple files in the next commit."
```

---

### Task 9: Offline queue — many files per queued expense

**Files:**
- Modify: `apps/web/src/lib/uploadQueue.ts:8,31-37,81-111,137-139`
- Modify: `apps/web/src/lib/uploadQueueSync.ts:46-68`
- Modify: `apps/web/src/pages/ToUpload.tsx:108`
- Modify: `apps/web/src/pages/ExpenseNew.tsx` (restore offline queueing)
- Create: `apps/web/src/lib/uploadQueue.migrate.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 6-8.
- Produces:
  - `function migrateQueueItem(raw: unknown): UploadQueueItem | null`
  - `UploadQueueItem.receipts: QueuedFile[]` replacing `receipt: QueuedFile`
  - `UploadQueueItem.uploadedIndexes: number[]`
  - `function receiptFilesFromQueueItem(item: UploadQueueItem): File[]`

A phone may be holding an unsynced expense right now. The `DB_VERSION` bump must rewrite those rows, not drop them.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/uploadQueue.migrate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { migrateQueueItem } from './uploadQueue';

const payload = { merchant: 'Acme', amount: 12.5, date: '2026-09-11', currency: 'USD' };
const oneFile = { name: 'a.jpg', type: 'image/jpeg', size: 3, data: new ArrayBuffer(3) };

describe('migrateQueueItem', () => {
  it('rewrites a v1 single-receipt row into the v2 array shape', () => {
    const v1 = {
      id: 'i1', clientKey: 'k1', createdAt: 1, updatedAt: 1,
      status: 'pending', retryCount: 0, payload, receipt: oneFile,
    };
    const out = migrateQueueItem(v1)!;
    expect(out.receipts).toHaveLength(1);
    expect(out.receipts[0].name).toBe('a.jpg');
    expect(out.uploadedIndexes).toEqual([]);
    expect('receipt' in out).toBe(false);
  });

  it('carries a v1 expenseId across, so a partial sync is not repeated', () => {
    const v1 = {
      id: 'i1', clientKey: 'k1', createdAt: 1, updatedAt: 1,
      status: 'failed', retryCount: 2, payload, receipt: oneFile, expenseId: 'e1',
    };
    expect(migrateQueueItem(v1)!.expenseId).toBe('e1');
  });

  it('leaves an already-migrated v2 row alone', () => {
    const v2 = {
      id: 'i1', clientKey: 'k1', createdAt: 1, updatedAt: 1,
      status: 'pending', retryCount: 0, payload,
      receipts: [oneFile, oneFile], uploadedIndexes: [0],
    };
    const out = migrateQueueItem(v2)!;
    expect(out.receipts).toHaveLength(2);
    expect(out.uploadedIndexes).toEqual([0]);
  });

  it('discards a row with no files at all rather than syncing an empty expense', () => {
    expect(migrateQueueItem({ id: 'i1', payload })).toBeNull();
    expect(migrateQueueItem(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test -w apps/web -- uploadQueue
```

Expected: FAIL — `migrateQueueItem` is not exported.

- [ ] **Step 3: Migrate the queue**

In `apps/web/src/lib/uploadQueue.ts`:

```ts
const DB_VERSION = 2;
```

Replace the `receipt` field on `UploadQueueItem` with:

```ts
export interface QueuedFile {
  name: string;
  type: string;
  size: number;
  data: ArrayBuffer;
}

  /** Receipt files stored as ArrayBuffers for IndexedDB, in page order. */
  receipts: QueuedFile[];
  /** Indexes of `receipts` already uploaded, so a retry does not duplicate them. */
  uploadedIndexes: number[];
```

Add the migration, exported so it is testable without IndexedDB:

```ts
/**
 * v1 stored one `receipt` per item. v2 stores `receipts[]`. A phone may be
 * holding an unsynced expense from v1 right now, so rows are rewritten rather
 * than dropped.
 */
export function migrateQueueItem(raw: unknown): UploadQueueItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Partial<UploadQueueItem> & { receipt?: QueuedFile };

  const receipts = Array.isArray(row.receipts)
    ? row.receipts
    : row.receipt ? [row.receipt] : [];
  if (receipts.length === 0) return null;

  const { receipt: _dropped, ...rest } = row;
  return {
    ...(rest as UploadQueueItem),
    receipts,
    uploadedIndexes: Array.isArray(row.uploadedIndexes) ? row.uploadedIndexes : [],
  };
}
```

Run it in `openDb`'s `onupgradeneeded` when upgrading from version 1, and defensively in `listUploadQueue`:

```ts
      req.onsuccess = () => {
        const items = (req.result as unknown[])
          .map(migrateQueueItem)
          .filter((i): i is UploadQueueItem => i !== null)
          .sort((a, b) => a.createdAt - b.createdAt);
        resolve(items);
      };
```

Change `enqueueUpload` to take `receipts: File[]`, mapping each through `arrayBuffer()`, and set `uploadedIndexes: []`. Replace `receiptFileFromQueueItem` with:

```ts
export function receiptFilesFromQueueItem(item: UploadQueueItem): File[] {
  return item.receipts.map((r) => new File([r.data], r.name, { type: r.type }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test -w apps/web -- uploadQueue
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Drain the queue file-by-file**

In `apps/web/src/lib/uploadQueueSync.ts`, replace the body of `syncOne` after the expense-create block with:

```ts
  const files = receiptFilesFromQueueItem(item);
  const uploaded = new Set(item.uploadedIndexes);

  for (let i = 0; i < files.length; i += 1) {
    if (uploaded.has(i)) continue;
    // Not the last file: hold the auto-push check so the expense does not reach
    // Zoho with only part of its receipts attached.
    const isLast = i === files.length - 1;
    await expenseApi.uploadReceipt(expenseId, files[i], { batch: !isLast });
    uploaded.add(i);
    await updateUploadItem(item.id, { uploadedIndexes: [...uploaded] });
  }
```

Update the import from `receiptFileFromQueueItem` to `receiptFilesFromQueueItem`.

A partial failure leaves `uploadedIndexes` recorded, so the next drain resumes rather than re-uploading. Note the edge: if the final file is the one that already succeeded and an earlier one is retried later, that retry is unbatched only when it is the last index — acceptable, because `maybeAutoPushPending` is idempotent for an already-pushed expense.

- [ ] **Step 6: Restore offline queueing on `ExpenseNew` and fix `ToUpload`**

In `ExpenseNew.tsx`, wrap the `?mode=scan` upload (and nothing else) so an offline failure queues rather than errors:

```tsx
    })().catch(async (err) => {
      if (isLikelyOfflineOrNetworkError(err)) {
        await enqueueUpload({
          payload: { merchant: form.merchant, amount: Number(form.amount) || 0, date: form.date, currency: form.currency },
          receipts: [captured],
          expenseId: expenseId ?? undefined,
          lastError: 'Receipt upload failed — queued for retry',
        });
        void qc.invalidateQueries({ queryKey: ['upload-queue-count'] });
        setError('You appear to be offline. The photo is queued and will retry automatically — you can keep filling out the form.');
      } else {
        setError('We could not upload that photo. Add it again below.');
      }
    });
```

In `ToUpload.tsx:108`, replace `{item.receipt.name}` with:

```tsx
                  {item.receipts[0]?.name}{item.receipts.length > 1 ? ` +${item.receipts.length - 1} more` : ''}
```

- [ ] **Step 7: Type-check, test and build**

```bash
npm run lint -w apps/web && npm run test -w apps/web && npm run build -w apps/web
```

Expected: all three PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/uploadQueue.ts apps/web/src/lib/uploadQueue.migrate.test.ts apps/web/src/lib/uploadQueueSync.ts apps/web/src/pages/ToUpload.tsx apps/web/src/pages/ExpenseNew.tsx
git commit -m "feat(web): queue several receipts per offline expense"
```

---

### Task 10: Version bump, changelog, docs

**Files:**
- Modify: `packages/shared/src/version.ts`
- Modify: `apps/api/package.json`, `apps/web/package.json`, `packages/shared/package.json`
- Modify: `docs/CHANGELOG.md`
- Modify: `docs/architecture.md`, `docs/SYNC_AND_OFFLINE.md`

**Interfaces:** none.

- [ ] **Step 1: Bump all four version strings to `1.13.0`**

```bash
sed -i '' "s/MIDAS_VERSION = '1.12.1'/MIDAS_VERSION = '1.13.0'/" packages/shared/src/version.ts
sed -i '' 's/"version": "1.12.1"/"version": "1.13.0"/' apps/api/package.json apps/web/package.json packages/shared/package.json
```

- [ ] **Step 2: Verify they agree**

```bash
grep -h 'MIDAS_VERSION\|"version": "1' packages/shared/src/version.ts apps/api/package.json apps/web/package.json packages/shared/package.json
```

Expected: four lines, all `1.13.0`. `docs/VERSIONING.md` forbids leaving them disagreeing.

- [ ] **Step 3: Add the changelog entry**

At the top of the entries in `docs/CHANGELOG.md`, matching the existing format:

```markdown
## 1.13.0

### Added
- Several images per expense or purchase order — take photos, upload files, or mix both. Up to 10 per entry, each removable and individually retryable.
- Multi-receipt entries reach Zoho Books as a single merged PDF, one page per image, in the order they were added. A lone receipt is still sent as-is.

### Changed
- Receipt uploads accept an optional `?batch=1` flag that holds the auto-approve/auto-push check until the last file of a batch has landed. Without it, an expense could push to Zoho with only its first photo attached.
- WebP receipts are transcoded to JPEG at any size on upload — `pdf-lib` cannot embed WebP, so they would otherwise be left out of the merged PDF.
- The offline upload queue stores several files per expense (IndexedDB v1 → v2; existing queued items are migrated, not dropped).

### Known limitations
- Only the first image prefills the form. On a multi-page purchase order, later pages are scanned and stored but their line items are entered by hand.
- Adding a receipt to an expense already pushed to Zoho does not update the Zoho attachment; the bundle is built at push time.
- Receipts already stored as WebP from before this release are excluded from the merged PDF and named in the sync warning.
```

- [ ] **Step 4: Update the two docs that describe the old single-file behavior**

In `docs/architecture.md`, find the receipts description and note that an expense or PO may carry up to 10 receipts, ordered by `uploadedAt`, merged into one PDF for Zoho by `receiptBundle.ts`.

In `docs/SYNC_AND_OFFLINE.md`, update the queue-item description to `receipts[]` + `uploadedIndexes`, and document `?batch=1`.

- [ ] **Step 5: Full verification**

```bash
npm run lint && npm run test -w apps/api && npm run test -w apps/web && npm run build
```

Expected: all PASS. Do not claim completion on any command you have not run and seen succeed.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/version.ts apps/api/package.json apps/web/package.json packages/shared/package.json docs/CHANGELOG.md docs/architecture.md docs/SYNC_AND_OFFLINE.md
git commit -m "chore: bump version to 1.13.0"
```

---

## Merge and Deploy

Not a task — run after all ten tasks are reviewed and green.

- [ ] Merge the feature branch to `main` and tag:

```bash
git checkout main && git merge --no-ff <branch> -m "Merge <branch> — v1.13.0"
git tag v1.13.0
git push origin main --tags
```

- [ ] Connect to the server network first — the laptop is not on the server LAN:

```bash
tailscale up --accept-routes
```

Wait for routes to settle before the next step.

- [ ] Deploy to CT 3120 using **`docker-compose.prod.yml` alone**. Both `api` and `web` build from that file; the base file, or the base merged with prod, silently misbuilds production.

```bash
docker compose -f docker-compose.prod.yml up --build -d
```

The API image must rebuild for the new `pdf-lib` dependency. There is no database migration.

- [ ] Verify the deployed version:

```bash
curl -s https://<midas-host>/api/v1/meta | grep 1.13.0
```

- [ ] Production smoke: attach two photos to a new expense, confirm both render on the detail page, push to Zoho, and confirm the Zoho Books attachment is a **2-page PDF**.

---

## Self-Review

**Spec coverage** — every section of the spec maps to a task:

| Spec section | Task |
|---|---|
| Component 1 — `receiptBundle.ts` | 1 |
| Component 1 — WebP gap (client half) | 5 |
| Component 2 — Zoho push call sites | 2 (expense), 3 (PO) |
| Component 3 — `?batch=1` | 4 (server), 5-6 (client), 9 (queue) |
| Component 4 — `receiptBatch.ts` | 5 |
| Component 5 — `ReceiptAttachments` | 6 (component), 7-8 (call sites) |
| Component 6 — Offline queue | 9 |
| Failure behavior table | 1 (unreadable), 2-3 (warnings), 6 (per-tile retry, cap), 9 (offline) |
| Testing section | 1, 2, 3, 4, 5, 9 |
| Versioning | 10 |
| Deployment | Merge and Deploy |

**Deviations from the spec, deliberate:**
- The spec's `BundleResult` gained `classifyReceipts` and `bundleReceiptProblem` as separately exported pure functions. Without them the warning rules would only be reachable through a database and a Zoho client, which is exactly what `zohoPoReceipt.ts` was factored to avoid.
- `ReceiptAttachments` gained an `onChange` prop, unstated in the spec. `ExpenseDetail` has to invalidate `['expense', id]` (not just the receipts list) or its missing-receipt banner goes stale.
- `PoReceiptOutcome` gained a `bundled` variant rather than reusing `rejected`, so "there was no receipt" stays distinguishable from "there were receipts but none could be attached" — the distinction the spec calls out explicitly.
- Task 7 drops the accountant-only OCR diagnostics block from `ExpenseDetail`. The spec did not mention it; it is called out in the task so a reviewer can reject that specific choice.
- Tasks 8 and 9 split the `ExpenseNew` offline path across two commits, leaving offline queueing briefly unavailable between them. Flagged in Task 8's commit message.

**Placeholder scan:** no `TBD`, no "add error handling", no "similar to Task N". Every code step carries the code.

**Type consistency:** `buildReceiptBundle(receipts, uploadsDir)` and `BundleResult.{file,skipped}` are identical in Tasks 1, 2, 3. `isBatchedUpload` exists twice on purpose with different signatures — `(raw: unknown)` in `apps/api/src/lib/batchFlag.ts` and `(index, total)` in `apps/web/src/lib/receiptBatch.ts`; they live in different workspaces and are never imported across. `receiptFilesFromQueueItem` (plural) replaces `receiptFileFromQueueItem` (singular) consistently in Task 9.

**Weakest point in this plan:** Task 6 ships a ~250-line React component with no automated test, because `apps/web` has no DOM harness. Its logic is in `receiptBatch.ts` (tested in Task 5), but the wiring — refs, sequential upload loop, slot transitions — is verified only by the manual smoke tests in Tasks 7 and 8. Do not skip those steps. If the component proves fragile in review, the right response is adding jsdom + testing-library to `apps/web` as its own piece of work, not loosening the checks here.
