# PO Receipts + PO Number Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a purchase order carry a receipt — uploaded, OCR'd, and attached to the Zoho Books PO — and retire a PO number field that never reached Zoho.

**Architecture:** `receipts` gains a second, mutually-exclusive owner column so one receipts table, one OCR pipeline and one uploads directory serve both expenses and purchase orders. The receipts router mounts twice, resolving its owner through one pure helper. `zohoPoPush` gains the same best-effort attach that expense push already has, against an endpoint the Zoho service contract already defines.

**Tech Stack:** Express 5 + Drizzle ORM + Zod (API), React 19 + TanStack Query (web), Vitest, multer for uploads, hand-written SQL migrations run by `src/db/runSqlMigrations.ts`.

**Spec:** `docs/superpowers/specs/2026-08-26-po-receipts-design.md`

## Global Constraints

- The receipt owner is **exactly one** of `expense_id` / `transaction_id` — enforced by a database `CHECK`, not by convention.
- The migration is **additive**: no existing receipt row is rewritten, and every one keeps its `expense_id`.
- A failed Zoho attach **never fails the push**. The Books record already exists; a failed attach marks the PO and logs at error level, and must never cause a re-push.
- `maybeAutoPushPending` runs for **expense receipts only** — it is expense-specific and must not fire for a PO.
- Tests run without a database: `cd apps/api && npm test` is DB-free (578 passing) and stays that way.
- Lint gates: `cd apps/api && npm run lint && npm test`; `cd apps/web && npm run lint && npm run build`.
- **Production applies migrations only via the `migrator` service.** The prod API container's CMD is `node dist/server.js` (`apps/api/Dockerfile:63`) — it runs no migrations and no `db:push`. `docs/OPERATIONS.md`'s "a container restart is sufficient" describes the *dev* target and is wrong for prod; Task 7 corrects it.

---

### Task 1: Polymorphic receipt owner (schema + migration)

**Files:**
- Modify: `apps/api/src/db/schema.ts:359-387` (the `receipts` table)
- Create: `apps/api/drizzle/0030_receipt_polymorphic_owner.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `receipts.transactionId` (nullable uuid) and a now-nullable `receipts.expenseId`, both used by Tasks 2-4. Drizzle's inferred `Receipt` type gains `transactionId: string | null` and changes `expenseId` to `string | null`.

- [ ] **Step 1: Change the schema**

In `apps/api/src/db/schema.ts`, extend the `pg-core` import to include `check`, then rewrite the `receipts` owner columns and table extras:

```ts
export const receipts = pgTable('receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Exactly one owner. A receipt belongs to an expense OR to a purchase-order
  // transaction — purchase orders have no expense row to hang from, and a
  // second receipts table would mean duplicating the OCR pipeline forever.
  expenseId: uuid('expense_id').references(() => expenses.id, { onDelete: 'cascade' }),
  transactionId: uuid('transaction_id').references(() => transactions.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  // ... every other column stays exactly as it is ...
}, (t) => [
  index('receipts_expense_id_idx').on(t.expenseId),
  index('receipts_transaction_id_idx').on(t.transactionId),
  // Ambiguity is the failure mode of a polymorphic owner: neither set, or both
  // set, must be impossible at the database level rather than by convention.
  check(
    'receipts_one_owner',
    sql`(${t.expenseId} IS NOT NULL) <> (${t.transactionId} IS NOT NULL)`,
  ),
]);
```

Leave every non-owner column untouched. `transactions` is declared at line 279, above `receipts`, so the reference resolves without reordering.

- [ ] **Step 2: Add the receipts→transaction relation**

Below, alongside `receiptsRelations` (schema.ts:584):

```ts
export const receiptsRelations = relations(receipts, ({ one }) => ({
  expense: one(expenses, { fields: [receipts.expenseId], references: [expenses.id] }),
  transaction: one(transactions, { fields: [receipts.transactionId], references: [transactions.id] }),
}));
```

- [ ] **Step 3: Write the migration**

Create `apps/api/drizzle/0030_receipt_polymorphic_owner.sql`:

```sql
-- Purchase orders require a receipt, but receipts could only belong to an
-- expense — and a purchase order is a `transactions` row with no expense.
--
-- Additive and idempotent: existing rows keep their expense_id untouched and
-- satisfy the new CHECK as-is, because transaction_id defaults to NULL.

ALTER TABLE receipts ADD COLUMN IF NOT EXISTS transaction_id uuid;

ALTER TABLE receipts DROP CONSTRAINT IF EXISTS receipts_transaction_id_fkey;
ALTER TABLE receipts
  ADD CONSTRAINT receipts_transaction_id_fkey
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE;

ALTER TABLE receipts ALTER COLUMN expense_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS receipts_transaction_id_idx ON receipts (transaction_id);

ALTER TABLE receipts DROP CONSTRAINT IF EXISTS receipts_one_owner;
ALTER TABLE receipts
  ADD CONSTRAINT receipts_one_owner
  CHECK ((expense_id IS NOT NULL) <> (transaction_id IS NOT NULL));
```

- [ ] **Step 4: Verify the type-check still passes**

Run: `cd apps/api && npm run lint`
Expected: FAILS, with errors wherever `receipt.expenseId` is now `string | null` but used as `string`. Record the list — Tasks 2 and 3 fix them. If it passes, the schema change did not take effect; re-check Step 1.

- [ ] **Step 5: Verify the migration against a copy of production data**

This is a prerequisite, not optional — production holds ~380 live receipt rows.

```bash
# Take a fresh prod dump (read-only on prod)
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && bash scripts/backup-midas.sh'"
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'ls -t /opt/midas/backups/db_*.sql.gz | head -1'"
# Copy it down, restore into a scratch database, apply the migration, verify
createdb midas_migration_check
gunzip -c <dump>.sql.gz | psql midas_migration_check
psql midas_migration_check -f apps/api/drizzle/0030_receipt_polymorphic_owner.sql
psql midas_migration_check -c "SELECT count(*) AS total,
  count(expense_id) AS with_expense,
  count(transaction_id) AS with_transaction FROM receipts;"
```

Expected: `total` equals `with_expense`, `with_transaction` is 0, and the statement completes without a constraint violation. Then confirm the CHECK actually bites:

```bash
psql midas_migration_check -c "INSERT INTO receipts (expense_id, transaction_id, filename, mime_type, size_bytes, storage_path) VALUES (NULL, NULL, 'x', 'image/png', 1, 'x');"
```

Expected: ERROR mentioning `receipts_one_owner`. Then `dropdb midas_migration_check`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle/0030_receipt_polymorphic_owner.sql
git commit -m "feat(receipts): let a receipt belong to a purchase order"
```

---

### Task 2: Receipt owner resolver

**Files:**
- Create: `apps/api/src/lib/receiptOwner.ts`
- Test: `apps/api/src/__tests__/receiptOwner.test.ts`

**Interfaces:**
- Consumes: nothing at runtime (pure).
- Produces, for Task 3:
  - `type ReceiptOwnerKind = 'expense' | 'transaction'`
  - `interface ReceiptOwnerRef { kind: ReceiptOwnerKind; id: string }`
  - `resolveReceiptOwner(params: { expenseId?: string; transactionId?: string }): ReceiptOwnerRef` — throws a 400 `AppError` when neither or both are present.
  - `receiptOwnerValues(owner: ReceiptOwnerRef): { expenseId: string | null; transactionId: string | null }` — column values for an insert.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/__tests__/receiptOwner.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveReceiptOwner, receiptOwnerValues } from '../lib/receiptOwner';

describe('resolveReceiptOwner', () => {
  it('resolves an expense-scoped route', () => {
    expect(resolveReceiptOwner({ expenseId: 'e1' })).toEqual({ kind: 'expense', id: 'e1' });
  });

  it('resolves a transaction-scoped route', () => {
    expect(resolveReceiptOwner({ transactionId: 't1' })).toEqual({ kind: 'transaction', id: 't1' });
  });

  it('refuses when neither owner is present', () => {
    expect(() => resolveReceiptOwner({})).toThrow(/owner/i);
  });

  it('refuses when both owners are present — the ambiguity the CHECK exists to prevent', () => {
    expect(() => resolveReceiptOwner({ expenseId: 'e1', transactionId: 't1' }))
      .toThrow(/owner/i);
  });

  it('carries a 400 status and code', () => {
    try {
      resolveReceiptOwner({});
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toMatchObject({ statusCode: 400, code: 'INVALID_RECEIPT_OWNER' });
    }
  });
});

describe('receiptOwnerValues', () => {
  it('sets only the expense column', () => {
    expect(receiptOwnerValues({ kind: 'expense', id: 'e1' }))
      .toEqual({ expenseId: 'e1', transactionId: null });
  });

  it('sets only the transaction column', () => {
    expect(receiptOwnerValues({ kind: 'transaction', id: 't1' }))
      .toEqual({ expenseId: null, transactionId: 't1' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/__tests__/receiptOwner.test.ts`
Expected: FAIL — `Failed to resolve import "../lib/receiptOwner"`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/lib/receiptOwner.ts`. Note the hand-rolled error: this module must stay importable without `DATABASE_URL`/`JWT_SECRET`, and importing `createError` would drag in `../config/env`, which `process.exit(1)`s outside a configured environment — the same reasoning `lib/queueScope.ts:1-8` documents.

```ts
// Which record a receipt belongs to.
//
// A receipt hangs from an expense or from a purchase-order transaction, never
// both and never neither. The database enforces that with a CHECK constraint;
// this resolves the route's params to the same rule before we ever reach it,
// so the failure is a 400 with a useful message rather than a 500 from
// Postgres.

import type { AppError } from '../middleware/error';

export type ReceiptOwnerKind = 'expense' | 'transaction';

export interface ReceiptOwnerRef {
  kind: ReceiptOwnerKind;
  id: string;
}

function invalidOwner(message: string): AppError {
  const err = new Error(message) as AppError;
  err.statusCode = 400;
  err.code = 'INVALID_RECEIPT_OWNER';
  return err;
}

/** Turn whichever route param is present into the receipt's owner. */
export function resolveReceiptOwner(params: {
  expenseId?: string;
  transactionId?: string;
}): ReceiptOwnerRef {
  const { expenseId, transactionId } = params;
  if (expenseId && transactionId) {
    throw invalidOwner('A receipt cannot belong to both an expense and a transaction');
  }
  if (expenseId) return { kind: 'expense', id: expenseId };
  if (transactionId) return { kind: 'transaction', id: transactionId };
  throw invalidOwner('A receipt needs an owner: no expense or transaction in the route');
}

/** Column values for an insert — the unused owner column is explicitly null. */
export function receiptOwnerValues(owner: ReceiptOwnerRef): {
  expenseId: string | null;
  transactionId: string | null;
} {
  return owner.kind === 'expense'
    ? { expenseId: owner.id, transactionId: null }
    : { expenseId: null, transactionId: owner.id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/__tests__/receiptOwner.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/receiptOwner.ts apps/api/src/__tests__/receiptOwner.test.ts
git commit -m "feat(receipts): resolve a receipt's owner from its route"
```

---

### Task 3: Owner-agnostic receipts routes

**Files:**
- Modify: `apps/api/src/routes/receipts.ts` (all handlers)
- Modify: `apps/api/src/routes/files.ts:44-55` (the authenticated file stream)
- Modify: `apps/api/src/server.ts:86` (add the second mount)

**Interfaces:**
- Consumes: `resolveReceiptOwner`, `receiptOwnerValues`, `ReceiptOwnerRef` (Task 2); `receipts.transactionId` (Task 1).
- Produces: `POST|GET /api/v1/transactions/:transactionId/receipts` and `GET|DELETE` of a single receipt beneath it, for Task 6's UI.

- [ ] **Step 1: Add the authorization helper**

At the top of `apps/api/src/routes/receipts.ts`, after the imports, add a helper that loads the owning record and applies the same access rule each owner already had:

```ts
/**
 * Load the owning record and authorize the caller against it.
 *
 * Ownership rules are unchanged per owner: an expense's own submitter, or an
 * accountant/admin. Purchase orders follow the transaction's `userId` the same
 * way. Returning the row lets callers reuse it without a second query.
 */
async function loadOwnerFor(
  owner: ReceiptOwnerRef,
  user: { id: string; role: string },
  { requireSubmitter }: { requireSubmitter: boolean },
) {
  if (owner.kind === 'expense') {
    const expense = await db.query.expenses.findFirst({ where: eq(expenses.id, owner.id) });
    if (!expense) throw notFound('Expense not found');
    const isOwner = expense.userId === user.id;
    if (requireSubmitter ? !isOwner : !(isOwner || roleAllowed(user.role, ['accountant', 'admin']))) {
      throw forbidden();
    }
    return { kind: 'expense' as const, userId: expense.userId };
  }

  const tx = await db.query.transactions.findFirst({ where: eq(transactions.id, owner.id) });
  if (!tx) throw notFound('Transaction not found');
  const isOwner = tx.userId === user.id;
  if (requireSubmitter ? !isOwner : !(isOwner || roleAllowed(user.role, ['accountant', 'admin']))) {
    throw forbidden();
  }
  return { kind: 'transaction' as const, userId: tx.userId };
}
```

Add `transactions` to the schema import on line 5 and import the resolver:

```ts
import { resolveReceiptOwner, receiptOwnerValues, type ReceiptOwnerRef } from '../lib/receiptOwner';
```

Enable the router to see both param names by declaring it with merged params — change the router construction near line 17 to `const router = Router({ mergeParams: true });` if it is not already.

- [ ] **Step 2: Make the upload handler owner-agnostic**

Replace the body of `router.post('/')` (receipts.ts:49-88) so it resolves the owner, writes both columns, and keeps auto-push expense-only:

```ts
router.post('/', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw createError('No file uploaded', 400, 'NO_FILE');

  const owner = resolveReceiptOwner(req.params);
  await loadOwnerFor(owner, req.user!, { requireSubmitter: true });

  const runAsync = req.query.async === '1' || req.query.async === 'true';

  // iPhone HEIC/HEIF photos become JPEG so OCR and browsers can read them.
  const file = await toJpegIfHeic(req.file.buffer, req.file.mimetype, req.file.originalname);
  const stored = await storage.save(file.buffer, file.filename, file.mimeType);

  const [receipt] = await db.insert(receipts).values({
    ...receiptOwnerValues(owner),
    filename: file.filename,
    mimeType: file.mimeType,
    sizeBytes: file.buffer.length,
    storagePath: stored.storagePath,
    ocrStatus: 'pending',
  }).returning();

  await auditLog({
    entityType: 'receipt',
    entityId: receipt.id,
    userId: req.user!.id,
    action: 'uploaded',
    after: { expenseId: receipt.expenseId, transactionId: receipt.transactionId },
  });

  // A receipt was often the last missing piece of a pending daily expense —
  // completing it auto-approves and pushes without accountant review. That
  // rule is expense-only; a purchase order always goes through its own review.
  const autoPush = owner.kind === 'expense'
    ? () => maybeAutoPushPending(owner.id, req.user!.id)
    : async () => undefined;

  if (runAsync) {
    // Escape hatch only — see docs/SYNC_AND_OFFLINE.md
    void runReceiptOcr(receipt.id, stored.storagePath).then(autoPush);
    res.status(201).json({ receipt, ocrMode: 'async' });
    return;
  }

  const withOcr = await runReceiptOcr(receipt.id, stored.storagePath);
  const completion = await autoPush();
  res.status(201).json({ receipt: withOcr, ocrMode: 'sync', autoPushed: completion?.autoPushed });
}));
```

- [ ] **Step 3: Make the list, content and delete handlers owner-agnostic**

For the list handler (receipts.ts:37-46), the content handler (:91) and the delete handler (:111), replace each `expenses.findFirst` + `expense.userId` block with `resolveReceiptOwner(req.params)` plus `loadOwnerFor(owner, req.user!, { requireSubmitter: false })`, and filter receipts by the owner column rather than `expenseId`:

```ts
const owner = resolveReceiptOwner(req.params);
await loadOwnerFor(owner, req.user!, { requireSubmitter: false });

const ownerFilter = owner.kind === 'expense'
  ? eq(receipts.expenseId, owner.id)
  : eq(receipts.transactionId, owner.id);
```

Use `ownerFilter` in the list query's `where`, and in the single-receipt lookups combine it with the id: `and(eq(receipts.id, req.params.receiptId), ownerFilter)`. The content route's own authorization (receipts.ts:112-115, which loads the receipt then its expense) uses the same `loadOwnerFor` call, so a PO receipt authorizes through its transaction.

- [ ] **Step 4: Fix the file-streaming route, which will otherwise 500 on every PO receipt**

`apps/api/src/routes/files.ts:44-55` is the URL `ReceiptPreview` actually loads, and it dereferences the expense relation unconditionally: `receipt.expense.userId`. Once `expense_id` is nullable that relation is `null` for a PO receipt, and the line throws `TypeError: Cannot read properties of null` → a 500 on every preview. Replace the handler body:

```ts
router.get('/receipts/:receiptId', asyncHandler(async (req, res) => {
  const receipt = await db.query.receipts.findFirst({
    where: eq(receipts.id, req.params.receiptId),
    with: {
      expense: { columns: { userId: true } },
      transaction: { columns: { userId: true } },
    },
  });
  if (!receipt) throw notFound('Receipt not found');

  // A receipt hangs from an expense or a purchase-order transaction; whichever
  // it is, the submitter and any accountant/admin may read the file.
  const submitterId = receipt.expense?.userId ?? receipt.transaction?.userId ?? null;
  const isOwner = submitterId !== null && submitterId === req.user!.id;
  if (!isOwner && !roleAllowed(req.user!.role, ['accountant', 'admin'])) throw forbidden();

  await streamFile(res, receipt.storagePath, receipt.mimeType, receipt.filename);
}));
```

The `transaction` relation this reads comes from Task 1 Step 2.

- [ ] **Step 5: Mount the second path**

In `apps/api/src/server.ts`, below line 86:

```ts
app.use('/api/v1/expenses/:expenseId/receipts', receiptsRouter);
app.use('/api/v1/transactions/:transactionId/receipts', receiptsRouter);
```

- [ ] **Step 6: Verify**

Run: `cd apps/api && npm run lint && npm test`
Expected: `tsc --noEmit` silent — including every `expenseId` nullability error Task 1 surfaced — and 585 tests passing (578 + Task 2's 7).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/receipts.ts apps/api/src/routes/files.ts apps/api/src/server.ts
git commit -m "feat(receipts): serve receipts for purchase orders too"
```

---

### Task 4: Attach the receipt to the Zoho purchase order

**Files:**
- Modify: `apps/api/src/lib/zoho.ts` (new client beside `attachReceiptToBooksExpense`, line 282)
- Modify: `apps/api/src/lib/zohoPoPush.ts` (attach step + receiptCount)
- Modify: `apps/api/src/lib/zohoPoPayload.ts` (populate `receiptCount`)
- Test: `apps/api/src/__tests__/zohoPoReceipt.test.ts`

**Interfaces:**
- Consumes: `receipts.transactionId` (Task 1).
- Produces: `attachReceiptToBooksPurchaseOrder(zohoPurchaseOrderId: string, file: { buffer: Buffer; filename: string; mimeType: string }, brand: string): Promise<boolean>` and `poReceiptWarning(problem: string | null): string | null`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/__tests__/zohoPoReceipt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { poReceiptWarning } from '../lib/zohoPoReceipt';

describe('poReceiptWarning', () => {
  it('is null when the receipt attached cleanly', () => {
    expect(poReceiptWarning(null)).toBeNull();
  });

  it('marks the PO without claiming the push failed', () => {
    const warning = poReceiptWarning('Zoho rejected the receipt upload');
    expect(warning).toBe('[RECEIPT_WARNING] Zoho rejected the receipt upload');
  });

  it('truncates to the zoho_sync_error column width', () => {
    const warning = poReceiptWarning('x'.repeat(600))!;
    expect(warning.length).toBeLessThanOrEqual(500);
    expect(warning.startsWith('[RECEIPT_WARNING] ')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/__tests__/zohoPoReceipt.test.ts`
Expected: FAIL — `Failed to resolve import "../lib/zohoPoReceipt"`.

- [ ] **Step 3: Write the pure helper**

Create `apps/api/src/lib/zohoPoReceipt.ts`:

```ts
// A purchase order whose receipt did not reach Zoho.
//
// The Books record exists either way, so a failed attach must never look like
// a failed push — re-pushing would duplicate the PO. It marks the row instead,
// mirroring the expense-side rule added in v1.3.2 after receipts silently
// stopped reaching Zoho for three weeks.

const PREFIX = '[RECEIPT_WARNING] ';
const MAX = 500;

export function poReceiptWarning(problem: string | null): string | null {
  if (!problem) return null;
  return `${PREFIX}${problem}`.slice(0, MAX);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/__tests__/zohoPoReceipt.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Add the Zoho client**

In `apps/api/src/lib/zoho.ts`, directly below `attachReceiptToBooksExpense` (which ends around line 312), add its PO counterpart. The endpoint is `POST /zoho/purchaseorders/attach_receipt` per `docs/ZOHO_PO_CONTRACT.md:14`:

```ts
export async function attachReceiptToBooksPurchaseOrder(
  zohoPurchaseOrderId: string,
  file: { buffer: Buffer; filename: string; mimeType: string },
  brand: string,
): Promise<boolean> {
  if (env.ZOHO_MODE !== 'service' || env.ZOHO_DRY_RUN) return false;
  const baseUrl = env.ZOHO_SERVICE_BASE_URL;
  if (!baseUrl || !env.ZOHO_SERVICE_TOKEN) return false;

  try {
    const form = new FormData();
    // Same field name as the expense attach: Zoho Books expects `receipt`, and
    // the integration service forwards multipart field names verbatim.
    form.append('receipt', new Blob([new Uint8Array(file.buffer)], { type: file.mimeType }), file.filename);
    const res = await fetchWithTimeout(
      `${baseUrl}/zoho/purchaseorders/attach_receipt/${encodeURIComponent(zohoPurchaseOrderId)}`,
      // No explicit Content-Type: fetch sets the multipart boundary itself.
      { method: 'POST', headers: serviceHeaders({}, brand), body: form },
      30000,
    );
    if (!res.ok) {
      logger.warn({ zohoPurchaseOrderId, brand, status: res.status }, 'Zoho PO receipt attach failed');
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err, zohoPurchaseOrderId, brand }, 'Zoho PO receipt attach failed');
    return false;
  }
}
```

- [ ] **Step 6: Wire the attach into the push**

In `apps/api/src/lib/zohoPoPush.ts`, inside the success branch after the `db.update(transactions)` that sets `integrationStatus: 'synced'` (around line 124), add the attach — modelled on `zohoPush.ts:135-170`:

```ts
    // Best-effort receipt attachment: the Books PO exists either way, so a
    // failed attach never fails the push — but it must never be silent either.
    let receiptProblem: string | null = null;
    const receipt = await db.query.receipts.findFirst({
      where: eq(receipts.transactionId, tx.id),
      orderBy: [asc(receipts.uploadedAt)],
    });
    if (receipt) {
      try {
        const buffer = await fs.readFile(path.join(env.UPLOADS_DIR, receipt.storagePath));
        const attached = await attachReceiptToBooksPurchaseOrder(
          result.zohoPurchaseOrderId,
          { buffer, filename: receipt.filename, mimeType: receipt.mimeType },
          resolveBrandFromEntity(tx.zohoEntity) ?? env.ZOHO_DEFAULT_BRAND,
        );
        if (!attached) receiptProblem = 'Zoho rejected the receipt upload';
      } catch (err) {
        receiptProblem = `receipt file could not be read (${receipt.storagePath})`;
        logger.error(
          { err, transactionId: tx.id, storagePath: receipt.storagePath, uploadsDir: env.UPLOADS_DIR },
          'Receipt unreadable — purchase order pushed to Zoho without its receipt',
        );
      }
      if (receiptProblem) {
        await db.update(transactions)
          .set({ zohoSyncError: poReceiptWarning(receiptProblem), updatedAt: new Date() })
          .where(eq(transactions.id, tx.id));
      }
    }
```

Add the imports this needs at the top of the file: `fs` from `node:fs/promises`, `path` from `node:path`, `asc` from `drizzle-orm`, `receipts` from `../db/schema`, `attachReceiptToBooksPurchaseOrder` from `./zoho`, `poReceiptWarning` from `./zohoPoReceipt`, and `logger` from `./logger` if not already imported.

- [ ] **Step 7: Populate receiptCount**

In `zohoPoPush.ts`, where `payloadInput` is built (around line 85, beside `poNumber: tx.purchaseOrder?.poNumber ?? null`), count the PO's receipts and pass it, so the payload's long-declared `receipt: { count }` field stops being permanently null:

```ts
  const receiptCount = await db.$count(receipts, eq(receipts.transactionId, tx.id));
```

and add `receiptCount,` to the `payloadInput` object. If `db.$count` is unavailable in this Drizzle version, use `db.select({ n: sql<number>\`count(*)::int\` }).from(receipts).where(eq(receipts.transactionId, tx.id))` and read `[0].n`.

Note on coverage: the spec asks that a failed attach leave the PO's Zoho record id intact. That lives inside a DB-backed route and has no pure seam, so it is verified by inspection instead — the update above sets only `zohoSyncError`, never `zohoRecordId` or `integrationStatus`. State that in your report rather than mocking a database around it.

- [ ] **Step 8: Verify**

Run: `cd apps/api && npm run lint && npm test`
Expected: `tsc --noEmit` silent; 588 tests passing (585 + 3).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/lib/zoho.ts apps/api/src/lib/zohoPoPush.ts apps/api/src/lib/zohoPoPayload.ts apps/api/src/lib/zohoPoReceipt.ts apps/api/src/__tests__/zohoPoReceipt.test.ts
git commit -m "feat(zoho): attach the receipt when pushing a purchase order"
```

---

### Task 5: Retire the PO number input

**Files:**
- Modify: `apps/api/src/routes/transactions.ts:49,250,356-359`
- Modify: `apps/api/src/lib/zohoPoPayload.ts` (drop `poNumber` from the service payload)
- Modify: `apps/web/src/pages/PurchaseOrderNew.tsx:66,121,188`

**Interfaces:**
- Consumes: nothing.
- Produces: `purchase_orders.po_number` is no longer written by user input; it is reserved for the number Zoho assigns.

- [ ] **Step 1: Stop accepting poNumber on create**

In `apps/api/src/routes/transactions.ts`, remove `poNumber` from the create schema (line 49) and from the insert (line 250). Leave the update path (line 356-359) able to write it — that is the seam the Zoho-assigned number will use — but add a comment above it:

```ts
  // po_number is no longer user input: Zoho assigns the number and Midas
  // records what it assigned. See docs/superpowers/specs/2026-08-26-po-receipts-design.md.
```

- [ ] **Step 2: Stop sending poNumber to the service**

In `apps/api/src/lib/zohoPoPayload.ts`, remove `poNumber` from `buildZohoPoServicePayload`'s returned object and from the `ZohoPoServicePayload` type. `toZohoBooksPoCreateBody` never referenced it, so the Books body is unchanged — verify by reading that function before and after.

- [ ] **Step 3: Remove the form field**

In `apps/web/src/pages/PurchaseOrderNew.tsx`, delete the `poNumber` state (line 66), the `poNumber` key in the submit payload (line 121), and the labelled input (line 188). The Company `<select>` beside it becomes the only field on that row — give the row a single-column layout so it does not render a stray empty half.

- [ ] **Step 4: Verify**

Run: `cd apps/api && npm run lint && npm test` then `cd apps/web && npm run lint && npm run build`
Expected: all silent/successful; 588 tests still passing.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/transactions.ts apps/api/src/lib/zohoPoPayload.ts apps/web/src/pages/PurchaseOrderNew.tsx
git commit -m "feat(po): retire the PO number input Zoho always overrode"
```

---

### Task 6: Receipt upload and display on the PO screens

**Files:**
- Modify: `apps/web/src/api/expenses.ts` (transaction-scoped receipt client)
- Modify: `apps/web/src/pages/PurchaseOrderNew.tsx` (upload control)
- Modify: `apps/web/src/pages/PurchaseOrderDetail.tsx` (receipt + OCR display)
- Modify: `apps/web/src/pages/ExpenseNew.tsx` (the Purchase order card's copy)

**Interfaces:**
- Consumes: `POST|GET /api/v1/transactions/:transactionId/receipts` (Task 3).
- Produces: nothing downstream.

- [ ] **Step 1: Add the API client methods**

In `apps/web/src/api/expenses.ts`, beside the existing receipt calls, add transaction-scoped equivalents:

```ts
export const transactionReceiptApi = {
  list: (transactionId: string) =>
    client.get<{ receipts: Receipt[] }>(`/transactions/${transactionId}/receipts`)
      .then((r) => r.data.receipts),

  upload: (transactionId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return client.post<{ receipt: Receipt; ocrMode: string }>(
      `/transactions/${transactionId}/receipts`,
      form,
    ).then((r) => r.data);
  },
};
```

- [ ] **Step 2: Fix the Add Transaction card copy**

In `apps/web/src/pages/ExpenseNew.tsx`, find the Purchase order option whose description reads `Vendor order with line items — no receipt to scan` and change it to `Vendor order with line items — attach the receipt too`. The claim it makes today is the bug this whole plan exists to fix.

- [ ] **Step 3: Add the upload control to the PO form**

**The upload belongs on the detail page, not this form.** A receipt needs a `transaction_id`, so the PO must exist first — and `PurchaseOrderNew.tsx:127` already does `onSuccess: (tx) => navigate(`/transactions/${tx.id}`)`, so the user is on the detail page the moment the draft saves. Do not restructure that flow to keep the user here.

So this step touches `PurchaseOrderNew.tsx` only to remove the stale claim, if any remains after Task 5, and the upload control itself goes in Step 4 on the detail page. Verify by reading the file that no "no receipt" copy survives here; if none does, this step is a no-op and you should say so in your report rather than inventing a change.

- [ ] **Step 4: Show the receipt on the PO detail**

In `apps/web/src/pages/PurchaseOrderDetail.tsx`, add both the upload control and the display.

**Upload:** a file input accepting `image/*,.pdf,.heic,.heif` (matching the expense flow's `accept`), calling `transactionReceiptApi.upload(id, file)`. Disable it while uploading and invalidate the receipts query on success.

**Display:** fetch `transactionReceiptApi.list(id)` and render each receipt with `ReceiptPreview` from `apps/web/src/components/ReceiptPreview.tsx`, plus the OCR text when `ocrStatus === 'done'`.

`ReceiptPreview` works unchanged for PO receipts: its `expenseId` prop is vestigial — `receiptContentUrl(_expenseId, receiptId)` (`ReceiptPreview.tsx:4-6`) ignores it entirely and returns `/api/v1/files/receipts/${receiptId}`, which is the route Task 3 Step 4 taught to authorize through either owner. Pass the transaction id as `expenseId` and add a one-line comment saying why that reads oddly, rather than changing the component's public props.

- [ ] **Step 5: Verify**

Run: `cd apps/web && npm run lint && npm run build`
Expected: both silent/successful.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/api/expenses.ts apps/web/src/pages/PurchaseOrderNew.tsx apps/web/src/pages/PurchaseOrderDetail.tsx apps/web/src/pages/ExpenseNew.tsx
git commit -m "feat(po): upload and show a purchase order's receipt"
```

---

### Task 7: Release prep and the migration runbook

**Files:**
- Modify: `packages/shared/src/version.ts`, `apps/api/package.json`, `apps/web/package.json`, `packages/shared/package.json`
- Modify: `docs/CHANGELOG.md`
- Modify: `docs/OPERATIONS.md` (the "Schema changes" section)

**Interfaces:**
- Consumes: everything above.
- Produces: a release ready for a human to deploy.

- [ ] **Step 1: Correct the schema-change runbook**

`docs/OPERATIONS.md`'s "Schema changes" section says the API container runs `db:push --force` on startup and that a restart is therefore sufficient. That is false for production: `apps/api/Dockerfile:63` gives the prod target `CMD ["sh", "-c", "node dist/server.js"]` — no migration, no push. Only the `migrator` service (`docker-compose.prod.yml:11-18`, `command: npm run db:migrate:sql && npm run db:seed`) applies migrations. Rewrite that section to say so, and to give the actual command:

```bash
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose -f docker-compose.prod.yml run --rm migrator'"
```

Note that the migrator builds `target: build`, which bakes `apps/api/drizzle/` into the image — so the tarball must be extracted and the image rebuilt *before* the migrator runs, or it will not see `0030`.

- [ ] **Step 2: Bump the version**

MINOR — new user-visible capability plus a schema change, no breaking API change. Set `1.6.0` in `packages/shared/src/version.ts` (`MIDAS_VERSION`) and the `"version"` field of all three package.json files. All four must agree per `docs/VERSIONING.md`.

- [ ] **Step 3: Write the changelog entry**

Add a `## 1.6.0 (2026-08-26)` section above `## 1.5.0`, matching the existing entries' voice. Cover: receipts on purchase orders (upload, OCR, and attachment to the Books PO); that a failed attach marks the PO rather than failing a push whose record already exists; the retired PO number input, including that it never reached Zoho in the first place; and that Zoho's assigned number is not yet displayed because the integration service does not return it.

- [ ] **Step 4: Verify everything**

```bash
cd apps/api && npm run lint && npm test
cd ../web && npm run lint && npm run build
```
Expected: silent/successful; 588 tests passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: bump version to 1.6.0"
```

- [ ] **Step 6: STOP — do not deploy**

Deployment requires the repo owner's explicit consent and has an ordering constraint that must not be improvised. Report the release as ready, and hand over this sequence for a human to authorize:

1. Confirm the `purchaseorders.attach_receipt` capability is granted in the Zoho integration service's Postgres. Without it every attach 403s and every PO gets a receipt warning.
2. Ship the tarball (do **not** rebuild api/web yet).
3. **Run the migrator first** — `docker compose -f docker-compose.prod.yml run --rm --build migrator`. `--build` is mandatory: CT 3120 already has a migrator image from 0027–0029, and `run` without it reuses that image (old `drizzle/` baked in), prints `SQL migrations complete` and exits 0 having applied nothing. Confirm `applying 0030_receipt_polymorphic_owner` appears in the output. 0030 is additive, so the currently-running 1.5.x API keeps working against the migrated schema — which is why the migration goes first, ahead of the rebuild, rather than after it.
4. **Then** rebuild api + web from `docker-compose.prod.yml` only.
5. Verify `/api/v1/meta` reports 1.6.0, then confirm `receipts` has `transaction_id` and the `receipts_one_owner` constraint on CT 3220.

Do not tag; the whole-branch review still follows and a tag placed now could point at a commit that review amends.

---

## Self-review notes

- **Spec coverage:** polymorphic receipts (T1), owner resolver (T2), routes + OCR (T3), Zoho attach + warning + receiptCount (T4), PO number retirement (T5), UI including the card copy (T6), release + the migration runbook (T7). The spec's "no hard block on a missing receipt" (Decision 6) needs no task — it is the existing behaviour, and no task adds a gate.
- **Not covered by design:** Zoho's assigned PO number never appears, because the integration service returns no `purchaseorder_number` and exposes no read-back. T5 reserves the column and T7's changelog states the limitation. Closing it is a change in the Zoho service repo.
- **Migration numbering:** `0030` follows `0029_app_connection_source_app.sql`. If another branch has landed a `0030` by execution time, renumber to the next free integer and say so in the report.
