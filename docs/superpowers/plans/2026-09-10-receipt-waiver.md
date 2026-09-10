# Accountant Receipt Waiver — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an accountant push an approved, receipt-less expense to Zoho by writing a required justification, which is stored on the expense, audited, and carried into the Zoho Books note.

**Architecture:** The receipt requirement becomes a real server-side rule inside `pushExpenseToZoho`, so every caller inherits it. The decision lives in a pure `receiptPushBlocker` function so it can be tested without a database. A waiver is passed as an optional argument by the one accountant route that accepts it, persisted to three new columns before the push is attempted, and read back on retries. Readiness, flags and the queue-lane SQL all learn to treat a waiver as satisfying the receipt condition.

**Tech Stack:** TypeScript / Node / Express / Drizzle / Zod / Vitest (API); React 18 / Vite / TanStack Query / Tailwind (web); PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-09-10-receipt-waiver-design.md`

## Global Constraints

- **Only the receipt is waivable.** Every other failing check stays a hard block. Overriding a missing Zoho account id cannot help — the payload guard would still fail.
- **`MAX_WAIVER_REASON = 200`** lives in `packages/shared` and is the single definition. The blocker, the route's zod schema and the web counter all read it from there.
- **`lib/zohoNotes.ts` imports nothing** — no db, no env, no `MAX_WAIVER_REASON`. It truncates against its own headline floor. Do not add an import to it.
- **`ZOHO_NOTE_MAX = 500` is a hard Zoho ceiling.** Overshooting earns a 1002 rejection that reaches the accountant as an opaque "sync failed". The builder must never emit more.
- **The waiver line yields, not the merchant.** If including the waiver in full would leave the headline under a 40-character floor, truncate the waiver line.
- **`POST /expenses/:id/submit` must never accept a waiver.** It is not role-gated. It must not read the field, so a submitter cannot self-waive.
- **API tests never touch a database.** The pattern is: extract a pure function into `src/lib/`, test that. `src/lib/poSubmitGate.ts` is the model.
- **Migrations here are hand-written SQL**, not `drizzle-kit generate` output. `apps/api/drizzle/meta/` holds only `0000_snapshot.json`; numbered `NNNN_*.sql` files are applied by the custom idempotent runner `src/db/runSqlMigrations.ts` (`npm run db:migrate:sql`). Write the SQL by hand and make it `IF NOT EXISTS`-idempotent, matching `0030_receipt_polymorphic_owner.sql`.
- **No new environment variables.**
- **Versions:** Midas `1.10.1 → 1.11.0` — MINOR. The OCR service is untouched.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/types/index.ts` (modify) | `MAX_WAIVER_REASON`; three waiver fields on `Expense` |
| `apps/api/src/lib/receiptPushBlocker.ts` (create) | The pure guard decision |
| `apps/api/src/__tests__/receiptPushBlocker.test.ts` (create) | Its tests |
| `apps/api/src/db/schema.ts` (modify) | Three columns on `expenses` |
| `apps/api/drizzle/0031_expense_receipt_waiver.sql` (create) | Hand-written idempotent migration |
| `apps/api/src/lib/zohoNotes.ts` (modify) | The waiver line and the headline floor |
| `apps/api/src/__tests__/zohoNotes.test.ts` (modify) | Note tests including the 500 ceiling |
| `apps/api/src/lib/zohoPayload.ts` (modify) | Waiver fields on `PayloadExpense` and `ZohoProvenance` |
| `apps/api/src/lib/zoho.ts` (modify) | Pass waiver through `toCreateBooksBody` |
| `apps/api/src/lib/zohoPush.ts` (modify) | Call the blocker; persist the waiver; audit |
| `apps/api/src/lib/zohoReadiness.ts` (modify) | Receipt-or-waiver |
| `apps/api/src/lib/flags.ts` (modify) | Receipt-or-waiver |
| `apps/api/src/lib/queueLane.ts` (modify) | Receipt-or-waiver, in SQL |
| `apps/api/src/__tests__/flags.test.ts` (modify) | Waived row reads ready |
| `apps/api/src/__tests__/zohoReadiness.test.ts` (modify) | Waived row reads ready |
| `apps/api/src/routes/accountant.ts` (modify) | Accept `receiptWaiverReason` on the single-expense push |
| `apps/web/src/api/expenses.ts` (modify) | `pushToZoho` takes an optional reason |
| `apps/web/src/components/ReceiptWaiverDialog.tsx` (create) | The dialog |
| `apps/web/src/pages/AccountantReview.tsx` (modify) | Override button; waiver in the receipt pane |
| `packages/shared/src/version.ts` + 3 `package.json` (modify) | `1.11.0` |
| `docs/CHANGELOG.md` (modify) | `1.11.0` entry |

---

## Task 1: Shared constant and type

**Files:**
- Modify: `packages/shared/src/types/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MAX_WAIVER_REASON = 200`; `Expense.receiptWaiverReason`, `Expense.receiptWaivedById`, `Expense.receiptWaivedAt`. Tasks 2, 8 and 9 all read the constant; Task 9 reads the fields.

- [ ] **Step 1: Add the constant and the type fields**

In `packages/shared/src/types/index.ts`, add above `export interface Expense` (around line 206):

```typescript
/**
 * Longest accountant justification for pushing an expense with no receipt.
 *
 * Lives here rather than in the API because the web dialog's character counter
 * needs it and `apps/web` cannot import from `apps/api`. The blocker and the
 * route's zod schema read it from here too, so the limit has one definition.
 *
 * Sized against the Zoho note budget: a typical provenance block is ~185 of the
 * 500-character ceiling, so 200 still leaves room for the merchant headline.
 */
export const MAX_WAIVER_REASON = 200;
```

Then add these three fields to the `Expense` interface, immediately after `receipts?: Receipt[];`:

```typescript
  /**
   * Why this expense was pushed to Zoho without a receipt. Set only by an
   * accountant; its presence is what lets the push guard pass.
   */
  receiptWaiverReason?: string | null;
  receiptWaivedById?: string | null;
  receiptWaivedAt?: string | null;
```

- [ ] **Step 2: Type-check**

Run: `cd ~/Work/midas && npm run lint`
Expected: clean. `MAX_WAIVER_REASON` is a value, not a type, so it is exported by the existing `export { … } from './...'` mechanism only if re-exported — `index.ts` IS the module here, so a bare `export const` is sufficient.

- [ ] **Step 3: Verify the constant is importable from both sides**

Run: `cd ~/Work/midas && node -e "console.log(require('fs').readFileSync('packages/shared/src/types/index.ts','utf8').includes('MAX_WAIVER_REASON'))"`
Expected: `true`

- [ ] **Step 4: Commit**

```bash
cd ~/Work/midas
git add packages/shared/src/types/index.ts
git commit -m "feat(shared): add MAX_WAIVER_REASON and receipt-waiver fields on Expense"
```

---

## Task 2: The push blocker

**Files:**
- Create: `apps/api/src/lib/receiptPushBlocker.ts`
- Create: `apps/api/src/__tests__/receiptPushBlocker.test.ts`

**Interfaces:**
- Consumes: `MAX_WAIVER_REASON` from Task 1.
- Produces: `receiptPushBlocker(input: ReceiptPushInput) → ReceiptPushBlocker | null`, where `ReceiptPushInput = { hasReceipt: boolean; storedWaiverReason: string | null; suppliedReason?: string }` and `ReceiptPushBlocker = { code: 'MISSING_RECEIPT' | 'INVALID_WAIVER_REASON'; status: 409 | 400; message: string }`. Also `normalizeWaiverReason(raw: string | undefined) → string | null`. Task 6 calls both.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/__tests__/receiptPushBlocker.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { MAX_WAIVER_REASON } from '@midas/shared';
import { receiptPushBlocker, normalizeWaiverReason } from '../lib/receiptPushBlocker';

const WITH_RECEIPT = { hasReceipt: true, storedWaiverReason: null };
const BARE = { hasReceipt: false, storedWaiverReason: null };

describe('receiptPushBlocker', () => {
  it('passes when a receipt is attached', () => {
    expect(receiptPushBlocker(WITH_RECEIPT)).toBeNull();
  });

  it('blocks a receipt-less expense with no waiver at all', () => {
    const blocker = receiptPushBlocker(BARE);
    expect(blocker?.code).toBe('MISSING_RECEIPT');
    expect(blocker?.status).toBe(409);
  });

  it('tells the accountant both ways out', () => {
    expect(receiptPushBlocker(BARE)!.message).toMatch(/reason/i);
    expect(receiptPushBlocker(BARE)!.message).toMatch(/attach/i);
  });

  it('passes on a reason supplied with this push', () => {
    expect(receiptPushBlocker({ ...BARE, suppliedReason: 'submitter lost it' })).toBeNull();
  });

  it('passes on a reason already stored, so a retry needs no retyping', () => {
    expect(receiptPushBlocker({ hasReceipt: false, storedWaiverReason: 'lost, verified on statement' }))
      .toBeNull();
  });

  it('rejects a whitespace-only reason rather than storing an empty justification', () => {
    const blocker = receiptPushBlocker({ ...BARE, suppliedReason: '   \n  ' });
    expect(blocker?.code).toBe('INVALID_WAIVER_REASON');
    expect(blocker?.status).toBe(400);
  });

  it('rejects a reason longer than the shared maximum', () => {
    const blocker = receiptPushBlocker({ ...BARE, suppliedReason: 'x'.repeat(MAX_WAIVER_REASON + 1) });
    expect(blocker?.code).toBe('INVALID_WAIVER_REASON');
  });

  it('accepts a reason of exactly the maximum length', () => {
    expect(receiptPushBlocker({ ...BARE, suppliedReason: 'x'.repeat(MAX_WAIVER_REASON) })).toBeNull();
  });

  it('measures the maximum after trimming, not before', () => {
    const padded = `  ${'x'.repeat(MAX_WAIVER_REASON)}  `;
    expect(receiptPushBlocker({ ...BARE, suppliedReason: padded })).toBeNull();
  });

  it('lets an attached receipt win even when a bad reason is also supplied', () => {
    expect(receiptPushBlocker({ ...WITH_RECEIPT, suppliedReason: '  ' })).toBeNull();
  });
});

describe('normalizeWaiverReason', () => {
  it('returns null for undefined, empty and whitespace', () => {
    expect(normalizeWaiverReason(undefined)).toBeNull();
    expect(normalizeWaiverReason('')).toBeNull();
    expect(normalizeWaiverReason('   ')).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeWaiverReason('  lost the receipt  ')).toBe('lost the receipt');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/Work/midas && npx vitest run --root apps/api src/__tests__/receiptPushBlocker.test.ts`
Expected: FAIL — cannot resolve `../lib/receiptPushBlocker`

- [ ] **Step 3: Implement the blocker**

Create `apps/api/src/lib/receiptPushBlocker.ts`:

```typescript
import { MAX_WAIVER_REASON } from '@midas/shared';

/**
 * Whether an expense may be pushed to Zoho given its receipt situation.
 *
 * A receipt is required. An accountant may push without one by writing a
 * justification, which is stored on the expense and carried into the Zoho note.
 * That is the only waivable check — every other push precondition is a
 * technical prerequisite (no account id, no paid-through id, no entity) where
 * waiving would not produce a valid payload anyway.
 *
 * Pure by design: `zohoPush` imports the database, so the decision lives here
 * where the DB-free API test suite can reach it. Same reason as
 * lib/poSubmitGate and lib/expenseDelete.
 */

export interface ReceiptPushInput {
  hasReceipt: boolean;
  /** Already on the row from an earlier waiver — this is what makes a retry work. */
  storedWaiverReason: string | null;
  /** Supplied by an accountant on this call. */
  suppliedReason?: string;
}

export interface ReceiptPushBlocker {
  code: 'MISSING_RECEIPT' | 'INVALID_WAIVER_REASON';
  status: 409 | 400;
  message: string;
}

/** Trimmed reason, or null when there is nothing usable. */
export function normalizeWaiverReason(raw: string | undefined | null): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

export function receiptPushBlocker(input: ReceiptPushInput): ReceiptPushBlocker | null {
  // A receipt settles it. Checked first so a malformed reason cannot block a
  // push that never needed a waiver.
  if (input.hasReceipt) return null;

  const supplied = normalizeWaiverReason(input.suppliedReason);

  // Distinguish "sent a reason we cannot use" from "sent no reason": the first
  // is a client bug worth a 400, the second is the ordinary blocked state.
  if (input.suppliedReason !== undefined && !supplied) {
    return {
      code: 'INVALID_WAIVER_REASON',
      status: 400,
      message: 'Write a reason for pushing without a receipt.',
    };
  }

  if (supplied && supplied.length > MAX_WAIVER_REASON) {
    return {
      code: 'INVALID_WAIVER_REASON',
      status: 400,
      message: `Keep the reason to ${MAX_WAIVER_REASON} characters or fewer.`,
    };
  }

  if (supplied) return null;
  if (normalizeWaiverReason(input.storedWaiverReason)) return null;

  return {
    code: 'MISSING_RECEIPT',
    status: 409,
    message: 'This expense has no receipt. Push it with a written reason, or ask the submitter to attach one.',
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/Work/midas && npx vitest run --root apps/api src/__tests__/receiptPushBlocker.test.ts`
Expected: PASS — 12 tests

- [ ] **Step 5: Run the full API suite and type-check**

Run: `cd ~/Work/midas && npm run test -w apps/api && npm run lint`
Expected: 644 + 12 = 656 passing, lint clean

- [ ] **Step 6: Commit**

```bash
cd ~/Work/midas
git add apps/api/src/lib/receiptPushBlocker.ts apps/api/src/__tests__/receiptPushBlocker.test.ts
git commit -m "feat(api): decide receipt-waiver pushes in a pure, testable guard"
```

---

## Task 3: Schema columns and migration

**Files:**
- Modify: `apps/api/src/db/schema.ts:223` (after `zohoRequestId`)
- Create: `apps/api/drizzle/0031_expense_receipt_waiver.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `expenses.receiptWaiverReason`, `expenses.receiptWaivedById`, `expenses.receiptWaivedAt` in the Drizzle schema, and the matching columns in the database. Tasks 5, 6, 7 and 8 read them.

- [ ] **Step 1: Add the columns to the Drizzle schema**

In `apps/api/src/db/schema.ts`, inside the `expenses` table, immediately after `zohoRequestId: text('zoho_request_id'),` (line 223) and before `createdAt`:

```typescript
  // ── Receipt waiver ─────────────────────────────────────────────────────────
  // An accountant may push an otherwise-complete expense with no receipt by
  // writing why. The reason is the audit artifact — it is sent to Zoho and it
  // is what lets the push guard pass on a retry without retyping.
  receiptWaiverReason: text('receipt_waiver_reason'),
  receiptWaivedById: uuid('receipt_waived_by_id').references(() => users.id, { onDelete: 'set null' }),
  receiptWaivedAt: timestamp('receipt_waived_at'),
```

- [ ] **Step 2: Write the migration by hand**

These migrations are **not** generated. `apps/api/drizzle/meta/` holds only `0000_snapshot.json`, and numbered files are applied by the idempotent runner at `src/db/runSqlMigrations.ts`. Do **not** run `db:generate`.

Create `apps/api/drizzle/0031_expense_receipt_waiver.sql`, matching the commented, idempotent style of `0030_receipt_polymorphic_owner.sql`:

```sql
-- An accountant can push an approved expense whose submitter lost the receipt,
-- but only by writing why. The reason is stored here rather than only in the
-- audit log so it survives a failed push (the retry reads it back instead of
-- asking for it again) and so the expense can show why it was waived.
--
-- Additive and idempotent: all three columns are nullable and existing rows
-- read as "not waived", which is the pre-change behaviour.

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS receipt_waiver_reason text;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS receipt_waived_by_id uuid;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS receipt_waived_at timestamp;

-- Named so a re-run is a no-op rather than a duplicate-constraint error.
-- ON DELETE SET NULL: the justification outlives the accountant who wrote it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'expenses_receipt_waived_by_id_fkey'
  ) THEN
    ALTER TABLE expenses
      ADD CONSTRAINT expenses_receipt_waived_by_id_fkey
      FOREIGN KEY (receipt_waived_by_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;
```

- [ ] **Step 3: Confirm the runner will pick it up**

Run: `cd ~/Work/midas && ls apps/api/drizzle/*.sql | tail -2`
Expected: `0030_receipt_polymorphic_owner.sql` and `0031_expense_receipt_waiver.sql`. The runner filters on `/^\d{4}_.+\.sql$/` and sorts, so `0031` runs after `0030`.

- [ ] **Step 4: Type-check**

Run: `cd ~/Work/midas && npm run lint`
Expected: clean. If `uuid` or `timestamp` is not already imported in `schema.ts`, add it — both are used elsewhere in the file, so they should already be there.

- [ ] **Step 5: Run the API suite**

Run: `cd ~/Work/midas && npm run test -w apps/api`
Expected: 656 passing, unchanged — no test touches the database.

- [ ] **Step 6: Commit**

```bash
cd ~/Work/midas
git add apps/api/src/db/schema.ts apps/api/drizzle/0031_expense_receipt_waiver.sql
git commit -m "feat(db): store the receipt waiver on the expense"
```

---

## Task 4: The Zoho note line

**Files:**
- Modify: `apps/api/src/lib/zohoNotes.ts`
- Modify: `apps/api/src/__tests__/zohoNotes.test.ts`

**Interfaces:**
- Consumes: nothing. **This file must keep importing nothing** — no db, no env, no `MAX_WAIVER_REASON`.
- Produces: `ZohoNoteInput.receiptWaivedBy?: string | null` and `ZohoNoteInput.receiptWaiverReason?: string | null`. Task 5 populates them.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/__tests__/zohoNotes.test.ts`:

```typescript
import { buildZohoNote, ZOHO_NOTE_MAX } from '../lib/zohoNotes';

const BASE = {
  headline: 'Urth Cafe — Breakfast last day KG/SP/SJ',
  event: null,
  submittedBy: 'Shruti Patel',
  submittedOn: '2026-09-09',
  pushedBy: 'Digi',
  pushedOn: '2026-09-10',
  origin: 'midas',
  midasUrl: 'https://midas.example.com/expenses/abc',
  midasId: 'abc',
};

describe('buildZohoNote — receipt waiver', () => {
  it('says nothing about a waiver when there is none', () => {
    expect(buildZohoNote(BASE)).not.toMatch(/waived/i);
  });

  it('names the waiver actor and the reason, after the Pushed by line', () => {
    const note = buildZohoNote({
      ...BASE,
      receiptWaivedBy: 'Digi',
      receiptWaiverReason: 'submitter lost the receipt; verified against the Amex statement',
    });
    expect(note).toContain('Receipt waived by Digi: submitter lost the receipt; verified against the Amex statement');
    expect(note.indexOf('Receipt waived by')).toBeGreaterThan(note.indexOf('Pushed by:'));
    expect(note.indexOf('Receipt waived by')).toBeLessThan(note.indexOf('Origin:'));
  });

  it('falls back to an unnamed waiver rather than printing null', () => {
    const note = buildZohoNote({ ...BASE, receiptWaivedBy: null, receiptWaiverReason: 'lost' });
    expect(note).toContain('Receipt waived: lost');
    expect(note).not.toMatch(/null/);
  });

  it('omits the line when a reason is blank', () => {
    expect(buildZohoNote({ ...BASE, receiptWaivedBy: 'Digi', receiptWaiverReason: '   ' }))
      .not.toMatch(/waived/i);
  });

  it('keeps the merchant headline when a 200-character reason is present', () => {
    const note = buildZohoNote({
      ...BASE,
      receiptWaivedBy: 'Digi',
      receiptWaiverReason: 'x'.repeat(200),
    });
    expect(note).toContain('Urth Cafe');
    expect(note.length).toBeLessThanOrEqual(ZOHO_NOTE_MAX);
  });

  it('truncates the waiver line rather than losing the merchant name', () => {
    const note = buildZohoNote({
      ...BASE,
      event: 'A Very Long Trade Show Name That Eats The Budget'.repeat(3),
      receiptWaivedBy: 'Digi',
      receiptWaiverReason: 'y'.repeat(200),
    });
    expect(note.length).toBeLessThanOrEqual(ZOHO_NOTE_MAX);
    expect(note).toContain('Urth Cafe');
    expect(note).toContain('…');
  });

  it('never exceeds the Zoho ceiling under any combination', () => {
    const note = buildZohoNote({
      ...BASE,
      headline: 'H'.repeat(400),
      event: 'E'.repeat(200),
      midasUrl: `https://midas.example.com/expenses/${'u'.repeat(120)}`,
      sourceUrl: `https://example.com/${'s'.repeat(120)}`,
      receiptWaivedBy: 'Digi',
      receiptWaiverReason: 'z'.repeat(200),
    });
    expect(note.length).toBeLessThanOrEqual(ZOHO_NOTE_MAX);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/Work/midas && npx vitest run --root apps/api src/__tests__/zohoNotes.test.ts`
Expected: FAIL — the waiver assertions fail; the note has no such line.

- [ ] **Step 3: Extend the input type**

In `apps/api/src/lib/zohoNotes.ts`, add to `ZohoNoteInput`, immediately after `pushedOn: string | null;`:

```typescript
  /** Accountant who pushed this without a receipt. May differ from pushedBy on a retry. */
  receiptWaivedBy?: string | null;
  /** Why it was pushed without a receipt. Omitted from the note when blank. */
  receiptWaiverReason?: string | null;
```

- [ ] **Step 4: Add the smallest headline the merchant needs**

Add near `ZOHO_NOTE_MAX`:

```typescript
/**
 * Smallest headline worth keeping. An earlier fix folded the merchant into the
 * description because Zoho drops it, leaving expenses unsearchable by name — so
 * when the budget is tight the waiver line is truncated to protect this, rather
 * than letting a long reason push the merchant out of the note entirely.
 */
const HEADLINE_FLOOR = 40;
```

- [ ] **Step 5: Build the waiver line and let it yield**

In `buildZohoNote`, replace the `lines` array construction and the block/headline assembly with:

```typescript
  const waiverReason = input.receiptWaiverReason?.trim();
  const waiverLine = waiverReason
    ? (input.receiptWaivedBy
      ? `Receipt waived by ${input.receiptWaivedBy}: ${waiverReason}`
      : `Receipt waived: ${waiverReason}`)
    : null;

  const lines = [
    `Event: ${eventLine}`,
    `Submitted by: ${actorLine(input.submittedBy, input.submittedOn)}`,
    `Pushed by: ${actorLine(input.pushedBy, input.pushedOn)}`,
    ...(waiverLine ? [waiverLine] : []),
    `Origin: ${originName(input.origin)}`,
    `Midas: ${input.midasUrl || input.midasId}`,
  ];
  if (input.sourceUrl) lines.push(`Source: ${input.sourceUrl}`);

  const rawBlock = lines.join('\n');
  let block = rawBlock.slice(0, max);

  // The waiver line is the one that gives way. Everything else in this block
  // exists only in Zoho; the full reason is still on the Midas record and the
  // note carries the link to it.
  //
  // Measure the overrun against `rawBlock`, NOT the already-sliced `block`:
  // once the raw block exceeds `max`, the sliced length is pinned at `max` and
  // the correction under-shoots, leaving the headline below its floor.
  const headline = input.headline?.trim();
  if (waiverLine && headline) {
    const reserve = Math.min(headline.length, HEADLINE_FLOOR);
    const overrun = rawBlock.length + 2 + reserve - max;
    if (overrun > 0) {
      const keep = Math.max(0, waiverLine.length - overrun - 1);
      const shortened = `${waiverLine.slice(0, keep)}…`;
      block = lines
        .map((l) => (l === waiverLine ? shortened : l))
        .join('\n')
        .slice(0, max);
    }
  }
```

Leave the rest of the function — the `if (!headline) return block;` branch and the budget arithmetic below it — exactly as it is.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd ~/Work/midas && npx vitest run --root apps/api src/__tests__/zohoNotes.test.ts`
Expected: PASS, including the pre-existing tests in the file

- [ ] **Step 7: Confirm the file still imports nothing**

Run: `cd ~/Work/midas && grep -c "^import" apps/api/src/lib/zohoNotes.ts`
Expected: `0` — the whole file, not just its head. It is `0` today; if this prints anything else, an import was added. Remove it: the file's testability, and the reason it can be exercised without a database or env, depends on having none.

- [ ] **Step 8: Run the full API suite**

Run: `cd ~/Work/midas && npm run test -w apps/api && npm run lint`
Expected: passing, lint clean

- [ ] **Step 9: Commit**

```bash
cd ~/Work/midas
git add apps/api/src/lib/zohoNotes.ts apps/api/src/__tests__/zohoNotes.test.ts
git commit -m "feat(zoho): carry the receipt waiver into the Books note"
```

---

## Task 5: Payload plumbing

**Files:**
- Modify: `apps/api/src/lib/zohoPayload.ts`
- Modify: `apps/api/src/lib/zoho.ts:364-377` (the `buildZohoNote` call in `toCreateBooksBody`)

**Interfaces:**
- Consumes: `ZohoNoteInput` waiver fields from Task 4.
- Produces: `PayloadExpense.receiptWaiverReason`, `.receiptWaivedByName`; `ZohoProvenance.receiptWaivedBy`, `.receiptWaiverReason`. Task 6 populates `PayloadExpense`.

- [ ] **Step 1: Add the fields to the payload types**

In `apps/api/src/lib/zohoPayload.ts`, add to `ZohoProvenance` (line 10), after `pushedOn`:

```typescript
  /** Accountant who waived the receipt requirement, resolved to a name. */
  receiptWaivedBy?: string | null;
  receiptWaiverReason?: string | null;
```

Add to `PayloadExpense`, after `pushedOn?: string | null;`:

```typescript
  /** Set when this expense is being pushed without a receipt. */
  receiptWaiverReason?: string | null;
  /** Resolved by the pusher — Zoho stores names, not Midas user ids. */
  receiptWaivedByName?: string | null;
```

- [ ] **Step 2: Populate provenance**

In `buildZohoServicePayload`, extend the `provenance` object:

```typescript
    provenance: {
      submittedBy: expense.submitterName ?? null,
      submittedOn: expense.submittedOn ?? null,
      pushedBy: expense.pushedByName ?? null,
      pushedOn: expense.pushedOn ?? null,
      receiptWaivedBy: expense.receiptWaivedByName ?? null,
      receiptWaiverReason: expense.receiptWaiverReason ?? null,
      midasUrl: midasRecordUrl('expenses', expense.id),
    },
```

- [ ] **Step 3: Pass them to the note builder**

In `apps/api/src/lib/zoho.ts`, extend the `buildZohoNote` call inside `toCreateBooksBody`:

```typescript
  const note = buildZohoNote({
    headline: description,
    event: p.source?.label ?? null,
    eventStart: p.source?.eventStart ?? null,
    eventEnd: p.source?.eventEnd ?? null,
    submittedBy: p.provenance?.submittedBy ?? null,
    submittedOn: p.provenance?.submittedOn ?? null,
    pushedBy: p.provenance?.pushedBy ?? null,
    pushedOn: p.provenance?.pushedOn ?? null,
    receiptWaivedBy: p.provenance?.receiptWaivedBy ?? null,
    receiptWaiverReason: p.provenance?.receiptWaiverReason ?? null,
    origin: p.source?.app ?? null,
    midasUrl: p.provenance?.midasUrl ?? null,
    midasId: 'expenseId' in p && p.expenseId ? p.expenseId : '',
    sourceUrl: p.source?.url ?? null,
  });
```

Nothing else in `toCreateBooksBody` changes. Provenance is read here before the nested objects are dropped from the wire body, so no extra work is needed to keep it.

- [ ] **Step 4: Type-check and run the suite**

Run: `cd ~/Work/midas && npm run lint && npm run test -w apps/api`
Expected: clean, passing

- [ ] **Step 5: Commit**

```bash
cd ~/Work/midas
git add apps/api/src/lib/zohoPayload.ts apps/api/src/lib/zoho.ts
git commit -m "feat(zoho): thread the receipt waiver through the payload provenance"
```

---

## Task 6: Enforce and record in `pushExpenseToZoho`

**Files:**
- Modify: `apps/api/src/lib/zohoPush.ts`

**Interfaces:**
- Consumes: `receiptPushBlocker`, `normalizeWaiverReason` (Task 2); the schema columns (Task 3); `PayloadExpense` waiver fields (Task 5).
- Produces: `pushExpenseToZoho(expense, actorUserId, opts?)` where `opts = { receiptWaiver?: { reason: string } }`. Task 8 passes it.

- [ ] **Step 1: Import the blocker**

Add to the imports in `apps/api/src/lib/zohoPush.ts`:

```typescript
import { receiptPushBlocker, normalizeWaiverReason } from './receiptPushBlocker';
```

- [ ] **Step 2: Widen the signature**

Change the function signature:

```typescript
export interface PushOptions {
  /**
   * An accountant's justification for pushing with no receipt. Only the
   * accountant routes pass this — `POST /expenses/:id/submit` is not
   * role-gated and never reads the field, so a submitter cannot self-waive.
   */
  receiptWaiver?: { reason: string };
}

export async function pushExpenseToZoho(
  expense: PushableExpense,
  actorUserId: string,
  opts?: PushOptions,
): Promise<ZohoPushOutcome> {
```

`PushableExpense` must also carry the stored waiver — add to its type:

```typescript
  receiptWaiverReason?: string | null;
```

- [ ] **Step 3: Call the blocker beside the existing guards**

Immediately after the `MISSING_PAYMENT_METHOD` guard and before
`const categoryEntityAccountId = …`:

```typescript
  // The receipt rule is enforced here rather than in each route so every caller
  // inherits it — four call sites reach this function, and a rule remembered
  // four times is a rule that drifts.
  const suppliedReason = normalizeWaiverReason(opts?.receiptWaiver?.reason) ?? undefined;
  const receiptBlocker = receiptPushBlocker({
    hasReceipt: (expense.receipts?.length ?? 0) > 0,
    storedWaiverReason: expense.receiptWaiverReason ?? null,
    suppliedReason: opts?.receiptWaiver ? (suppliedReason ?? opts.receiptWaiver.reason) : undefined,
  });
  if (receiptBlocker) {
    return {
      ok: false,
      status: receiptBlocker.status,
      code: receiptBlocker.code,
      message: receiptBlocker.message,
    };
  }
```

`ZohoPushOutcome.status` is currently typed `409 | 502` (`zohoPush.ts:49`). Widen it to `400 | 409 | 502`, or the `INVALID_WAIVER_REASON` branch will not type-check:

```typescript
  | { ok: false; status: 400 | 409 | 502; code: string; message: string; requestId?: string };
```

- [ ] **Step 4: Persist the waiver before attempting the push**

Directly after the blocker check:

```typescript
  // Written before the push, not after: a push that fails still leaves the
  // justification on the record, so the retry reads it back instead of asking
  // the accountant to type it again. A row that is already waived keeps its
  // original reason — the first justification is the one that was reviewed.
  const storedWaiver = normalizeWaiverReason(expense.receiptWaiverReason);
  let waiverReason = storedWaiver;
  if (suppliedReason && !storedWaiver) {
    const waivedAt = new Date();
    await db.update(expenses)
      .set({
        receiptWaiverReason: suppliedReason,
        receiptWaivedById: actorUserId,
        receiptWaivedAt: waivedAt,
        updatedAt: waivedAt,
      })
      .where(eq(expenses.id, expense.id));
    waiverReason = suppliedReason;
    await auditLog({
      entityType: 'expense',
      entityId: expense.id,
      userId: actorUserId,
      action: 'expense.receipt_waived',
      after: { receiptWaiverReason: suppliedReason },
      metadata: { reason: suppliedReason },
    });
  }
```

- [ ] **Step 5: Feed the waiver into the payload**

`resolveUserNames` is already called a few lines below with `[expense.userId, actorUserId]`. Extend the `buildZohoServicePayload` call to carry the waiver:

```typescript
  const waivedById = expense.receiptWaivedById ?? (waiverReason ? actorUserId : null);
  const payload = buildZohoServicePayload({
    ...expense,
    categoryEntityAccountId,
    submitterName: expense.userId ? names.get(expense.userId) ?? null : null,
    submittedOn: toDateOnly(expense.createdAt),
    pushedByName: names.get(actorUserId) ?? null,
    pushedOn: toDateOnly(new Date()),
    eventStartDate: eventDates?.startDate ?? null,
    eventEndDate: eventDates?.endDate ?? null,
    receiptWaiverReason: waiverReason,
    receiptWaivedByName: waivedById ? names.get(waivedById) ?? null : null,
  });
```

Add `expense.receiptWaivedById` to the `resolveUserNames` argument so the waiver actor's name resolves on a retry by a different accountant:

```typescript
  const names = await resolveUserNames([expense.userId, actorUserId, expense.receiptWaivedById ?? null]);
```

Add `receiptWaivedById?: string | null;` to `PushableExpense`. No filtering is needed — `resolveUserNames` is typed `Array<string | null | undefined>` and drops falsy ids itself (`userNames.ts:12-15`).

- [ ] **Step 6: Type-check and run the suite**

Run: `cd ~/Work/midas && npm run lint && npm run test -w apps/api`
Expected: clean, passing. If a test fixture now fails because a receipt-less expense no longer pushes, that is the intended behavior change — update the fixture to include a receipt or a waiver, and note it in the report.

- [ ] **Step 7: Commit**

```bash
cd ~/Work/midas
git add apps/api/src/lib/zohoPush.ts
git commit -m "feat(api): require a receipt to push, or a written waiver"
```

---

## Task 7: Readiness, flags and the lane

**Files:**
- Modify: `apps/api/src/lib/zohoReadiness.ts:60`
- Modify: `apps/api/src/lib/flags.ts:51,70`
- Modify: `apps/api/src/lib/queueLane.ts:15`
- Modify: `apps/api/src/__tests__/zohoReadiness.test.ts`
- Modify: `apps/api/src/__tests__/flags.test.ts`

**Interfaces:**
- Consumes: the schema columns (Task 3).
- Produces: a waived expense reads as ready in all three. Task 9 relies on `zohoReady` being true for a waived row.

**Why all three:** without this, a waived expense whose push then failed sits outside the `ready_for_zoho` lane and cannot be retried — defeating the reason the waiver is stored on the row.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/__tests__/zohoReadiness.test.ts`:

```typescript
describe('evaluateZohoReadiness — receipt waiver', () => {
  // Build on whatever complete fixture this file already uses; the only
  // difference between these two cases is the waiver.
  function waivable(overrides: Record<string, unknown> = {}) {
    return { ...READY_FIXTURE, receipts: [], ...overrides };
  }

  it('is not ready with no receipt and no waiver', () => {
    const result = evaluateZohoReadiness(waivable() as never);
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('receipt attachment');
  });

  it('is ready with no receipt when a waiver is recorded', () => {
    const result = evaluateZohoReadiness(waivable({ receiptWaiverReason: 'lost; verified' }) as never);
    expect(result.ready).toBe(true);
    expect(result.missing).not.toContain('receipt attachment');
  });

  it('labels the check so an accountant can tell a waiver from a receipt', () => {
    const result = evaluateZohoReadiness(waivable({ receiptWaiverReason: 'lost' }) as never);
    const check = result.checks.find((c) => c.label.startsWith('Receipt'));
    expect(check?.label).toBe('Receipt attached (or waived)');
    expect(check?.pass).toBe(true);
  });
});
```

Replace `READY_FIXTURE` with whatever the file's existing complete-expense fixture is named. If there is none, build one from the fields `evaluateZohoReadiness` reads: `status: 'approved'`, `merchant`, `amount`, `date`, `userId`, `categoryId`, `paymentMethodId`, `paymentMethod: { zohoAccountName: '1234567890' }`, `zohoEntity`, `receipts`.

Append to `apps/api/src/__tests__/flags.test.ts`:

```typescript
describe('computeFlags — receipt waiver', () => {
  function waived(extra: Record<string, unknown> = {}) {
    return {
      status: 'approved',
      zohoEntity: 'HAUTE',
      categoryId: 'cat-1',
      paymentMethodId: 'pm-1',
      paymentMethod: { zohoAccountName: '1234567890' },
      receipts: [],
      reimbursementStatus: 'not_requested',
      ...extra,
    };
  }

  it('does not mark a receipt-less expense ready without a waiver', () => {
    expect(computeFlags(waived() as never)).not.toContain('ready_for_zoho');
  });

  it('marks a waived receipt-less expense ready, so a failed push can be retried', () => {
    const flags = computeFlags(waived({ receiptWaiverReason: 'lost; verified' }) as never);
    expect(flags).toContain('ready_for_zoho');
  });

  it('still flags the missing receipt, because it really is missing', () => {
    const flags = computeFlags(waived({ receiptWaiverReason: 'lost' }) as never);
    expect(flags).toContain('missing_receipt');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ~/Work/midas && npx vitest run --root apps/api src/__tests__/zohoReadiness.test.ts src/__tests__/flags.test.ts`
Expected: FAIL — the waived cases are not ready

- [ ] **Step 3: Update `zohoReadiness.ts`**

Add `receiptWaiverReason?: string | null;` to `ReadinessExpense`. Then change the receipt determination:

```typescript
  // A waiver is an accountant's written justification, stored on the row. It
  // satisfies this check so a waived-then-failed push stays retryable; the
  // `missing_receipt` flag still fires, because the receipt really is missing.
  const hasWaiver = !!expense.receiptWaiverReason?.trim();
  const hasReceipt = (expense.receipts?.length ?? 0) > 0 || hasWaiver;
```

Change the check label:

```typescript
    { label: 'Receipt attached (or waived)', pass: hasReceipt },
```

Add a cross-reference comment above `hasWaiver`:

```typescript
  // One rule, three expressions: lib/flags.ts (computeFlags) and
  // lib/queueLane.ts (SQL) must agree with this. The SQL one is unreachable
  // from the DB-free test suite — change all three together.
```

- [ ] **Step 4: Update `flags.ts`**

Add `receiptWaiverReason?: string | null;` to `FlagsInput`. Then, inside `computeFlags`:

```typescript
  // See lib/zohoReadiness.ts and lib/queueLane.ts — the same rule, three ways.
  const hasWaiver = !!row.receiptWaiverReason?.trim();
```

Leave line 51 (`missing_receipt`) exactly as it is — a waived expense genuinely has no receipt and should still carry that flag. Change only the `zohoReady` term:

```typescript
    ((row.receipts?.length ?? 0) > 0 || hasWaiver);
```

- [ ] **Step 5: Update `queueLane.ts`**

Replace the receipts `exists` clause:

```typescript
    // See lib/flags.ts and lib/zohoReadiness.ts — the same rule, three ways.
    // No test reaches this one: the API suite never touches a database, so this
    // clause is verified by review and by the post-deploy lane check.
    or(
      sql`exists (select 1 from receipts r where r.expense_id = ${expenses.id})`,
      isNotNull(expenses.receiptWaiverReason),
    ),
```

`or` and `isNotNull` are already imported in this file.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd ~/Work/midas && npx vitest run --root apps/api src/__tests__/zohoReadiness.test.ts src/__tests__/flags.test.ts`
Expected: PASS

- [ ] **Step 7: Run the full suite and type-check**

Run: `cd ~/Work/midas && npm run test -w apps/api && npm run lint`
Expected: passing, clean

- [ ] **Step 8: Commit**

```bash
cd ~/Work/midas
git add apps/api/src/lib/zohoReadiness.ts apps/api/src/lib/flags.ts apps/api/src/lib/queueLane.ts apps/api/src/__tests__/zohoReadiness.test.ts apps/api/src/__tests__/flags.test.ts
git commit -m "feat(api): treat a receipt waiver as satisfying the receipt check"
```

---

## Task 8: The accountant route

**Files:**
- Modify: `apps/api/src/routes/accountant.ts:753-784`

**Interfaces:**
- Consumes: `pushExpenseToZoho(expense, actorUserId, opts)` (Task 6); `MAX_WAIVER_REASON` (Task 1).
- Produces: `POST /accountant/expenses/:id/zoho-push` accepting `{ receiptWaiverReason?: string }`. Task 9 sends it.

**Not in scope:** `POST /accountant/zoho/bulk-push` (line 435) is **unchanged**. A waived expense carries its reason on the row, so bulk retries pass the guard without a parameter.

- [ ] **Step 1: Add the request schema**

Near the other zod schemas in `apps/api/src/routes/accountant.ts`:

```typescript
// Only this route accepts a waiver. POST /expenses/:id/submit is not
// role-gated and never reads the field, so a submitter cannot self-waive.
const zohoPushSchema = z.object({
  receiptWaiverReason: z.string().trim().min(1).max(MAX_WAIVER_REASON).optional(),
});
```

Add `MAX_WAIVER_REASON` to the existing `@midas/shared` import in this file.

- [ ] **Step 2: Load the waiver column and pass the option**

In the `POST /expenses/:id/zoho-push` handler, parse the body and pass it through. The `findFirst` already selects the whole expense row, so `receiptWaiverReason` arrives without a change to the query:

```typescript
router.post('/expenses/:id/zoho-push', asyncHandler(async (req, res) => {
  const { receiptWaiverReason } = zohoPushSchema.parse(req.body ?? {});
  const expense = await db.query.expenses.findFirst({
```

and the push call:

```typescript
  const outcome = await pushExpenseToZoho(
    expense,
    req.user!.id,
    receiptWaiverReason ? { receiptWaiver: { reason: receiptWaiverReason } } : undefined,
  );
```

- [ ] **Step 3: Surface the blocker's status faithfully**

The handler currently maps anything that is not 409 to a 502. A waiver problem returns 400, which must not become a 502. Replace the tail of the handler:

```typescript
  if (outcome.ok) {
    res.json({ expense: outcome.expense, zoho: outcome.zoho });
    return;
  }
  // 400 (bad waiver reason) and 409 (blocked) are both the caller's to fix;
  // only a genuine integration failure is a 502.
  if (outcome.status === 400 || outcome.status === 409) {
    throw createError(outcome.message, outcome.status, outcome.code);
  }
  res.status(502).json({
    error: {
      code: outcome.code,
      message: outcome.message,
      requestId: outcome.requestId,
    },
  });
}));
```

No cast is needed — `createError(message, statusCode: number, code, extras?)` takes a plain `number` (`middleware/error.ts:65-69`).

- [ ] **Step 4: Type-check and run the suite**

Run: `cd ~/Work/midas && npm run lint && npm run test -w apps/api`
Expected: clean, passing

- [ ] **Step 5: Commit**

```bash
cd ~/Work/midas
git add apps/api/src/routes/accountant.ts
git commit -m "feat(api): accept a receipt-waiver reason on the accountant push"
```

---

## Task 9: The accountant's flow

**Files:**
- Modify: `apps/web/src/api/expenses.ts:256`
- Create: `apps/web/src/components/ReceiptWaiverDialog.tsx`
- Modify: `apps/web/src/pages/AccountantReview.tsx` — `ReceiptPane` (line 37), `ZohoReadinessCard` (line 126), and the page body

**Interfaces:**
- Consumes: `MAX_WAIVER_REASON` and the `Expense` waiver fields (Task 1); the route parameter (Task 8).
- Produces: the user-facing flow. Nothing depends on it.

`apps/web` has one test file and no component harness, so this task is verified by `npm run lint`, `npm run build`, and by hand. Do not claim browser verification you did not perform.

- [ ] **Step 1: Let the API client carry a reason**

In `apps/web/src/api/expenses.ts`:

```typescript
  pushToZoho: (id: string, receiptWaiverReason?: string) =>
    client.post(`/accountant/expenses/${id}/zoho-push`,
      receiptWaiverReason ? { receiptWaiverReason } : {},
    ).then((r) => r.data),
```

The parameter is optional, so the existing call site keeps compiling.

- [ ] **Step 2: Build the dialog**

Create `apps/web/src/components/ReceiptWaiverDialog.tsx`:

```tsx
import { useState } from 'react';
import { MAX_WAIVER_REASON } from '@midas/shared';
import { Modal } from './Modal';

export interface ReceiptWaiverDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  /** Shown as the subtitle so the accountant can see what they are waiving. */
  subtitle: string;
  pending: boolean;
  error?: string | null;
}

/**
 * Asks why an expense is being pushed with no receipt.
 *
 * The copy states that the note reaches Zoho, because an accountant writing an
 * internal aside would word it differently from one writing into the
 * accounting record.
 */
export function ReceiptWaiverDialog({
  open, onClose, onConfirm, subtitle, pending, error,
}: ReceiptWaiverDialogProps) {
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const tooLong = trimmed.length > MAX_WAIVER_REASON;
  const canConfirm = trimmed.length > 0 && !tooLong && !pending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={pending}
      dismissOnBackdrop={false}
      title="Push without a receipt"
      subtitle={subtitle}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="min-h-11 rounded-lg border border-ink/15 px-4 py-2 text-sm font-medium text-ink disabled:opacity-50 lg:min-h-0"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(trimmed)}
            disabled={!canConfirm}
            className="min-h-11 rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-cream hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-0"
          >
            {pending ? 'Pushing…' : 'Push to Zoho'}
          </button>
        </>
      }
    >
      <p className="mb-3 text-sm text-charcoal/70">
        This expense has no receipt. Explain why it is being pushed anyway — your
        note goes to Zoho and stays on the Midas record.
      </p>
      <label className="block text-sm">
        <span className="flex items-center justify-between">
          <span className="text-charcoal/80">Reason (required)</span>
          <span className={`text-xs ${tooLong ? 'text-danger' : 'text-charcoal/50'}`}>
            {trimmed.length}/{MAX_WAIVER_REASON}
          </span>
        </span>
        <textarea
          autoFocus
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          placeholder="e.g. submitter lost the receipt; charge verified against the card statement"
        />
      </label>
      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}
```

- [ ] **Step 3: Show the waiver in the receipt pane**

In `apps/web/src/pages/AccountantReview.tsx`, replace the empty branch of `ReceiptPane`:

```tsx
function ReceiptPane({ expense }: { expense: Expense }) {
  const receipts = expense.receipts ?? [];
  if (receipts.length === 0) {
    const waiver = expense.receiptWaiverReason?.trim();
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-ink/15 bg-cream px-6 text-center text-sm text-charcoal/40 lg:h-full lg:min-h-[24rem]">
        <span>No receipt attached</span>
        {/* The readiness card disappears once the expense is synced, so the
            justification lives here instead — where the absence is visible and
            the record keeps it for good. */}
        {waiver && (
          <p className="max-w-sm rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-left text-xs text-amber-900">
            <span className="font-semibold">Receipt waived</span>
            {expense.receiptWaivedAt ? ` on ${new Date(expense.receiptWaivedAt).toLocaleDateString()}` : ''}
            {': '}
            {waiver}
          </p>
        )}
      </div>
    );
  }
```

Leave the rest of the function unchanged.

- [ ] **Step 4: Teach the card about waivers, then add the override button**

The card computes its own readiness in the browser. It must mirror the server
rule from Task 7, or a waived expense whose push then *failed* would render
"Not ready" and prompt for a justification a second time — and that second
reason would be silently discarded, because the push deliberately keeps the
first one.

Change the receipt determination near the top of `ZohoReadinessCard`:

```tsx
  // Mirrors lib/zohoReadiness.ts and lib/flags.ts: a recorded waiver satisfies
  // the receipt check. Without this, a waived-then-failed push asks the
  // accountant to justify it again and throws that second reason away.
  const hasWaiver = !!expense.receiptWaiverReason?.trim();
  const hasReceipt = (expense.receipts?.length ?? 0) > 0 || hasWaiver;
```

Then, after `failed` is built, add:

```tsx
  // Offered only when a missing receipt is the single problem and no waiver
  // exists yet. Waiving does not help a missing account id — the push would
  // still fail at the payload guard, so a button that then errors is worse
  // than no button.
  const receiptIsOnlyBlocker = !hasWaiver && failed.length === 1;
```

Leave `if (!hasReceipt) failed.push('Receipt attached');` exactly as it is. With
`hasReceipt` now including waivers, the two cases fall out cleanly: an un-waived,
receipt-less, otherwise-complete expense produces exactly one failing check, and a
waived one produces none. So `failed.length === 1` combined with `!hasWaiver`
identifies the override case without comparing against the label text — never
string-match `failed[0]`, since the label is display copy and will drift.

Extend the props with `onWaivePush: () => void`, and in the not-ready branch — after the failed checklist — render:

```tsx
      {receiptIsOnlyBlocker && (
        <button
          type="button"
          onClick={onWaivePush}
          disabled={pushing}
          className="mt-3 min-h-11 w-full cursor-pointer rounded-lg border border-brand-500/40 bg-brand-500/10 px-4 py-2 text-sm font-semibold text-brand-800 hover:bg-brand-500/15 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto lg:min-h-0"
        >
          Push without receipt…
        </button>
      )}
```

- [ ] **Step 5: Wire the dialog into the page**

In the page component, add state and pass the reason through the existing mutation:

```tsx
  const [waiverOpen, setWaiverOpen] = useState(false);
```

Change `zohoRetryMutation` to accept an optional reason:

```tsx
  const zohoRetryMutation = useMutation({
    mutationFn: (receiptWaiverReason?: string) => accountantApi.pushToZoho(id!, receiptWaiverReason),
    onMutate: () => setZohoPushError(''),
    onSuccess: () => setWaiverOpen(false),
    onError: (err: any) => {
      setZohoPushError(err?.response?.data?.error?.message ?? 'Zoho push failed.');
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['expense', id] });
      qc.invalidateQueries({ queryKey: ['accountant-queue'] });
      qc.invalidateQueries({ queryKey: ['accountant-queue-summary'] });
    },
  });
```

Existing callers become `zohoRetryMutation.mutate(undefined)`. Pass `onWaivePush={() => { setZohoPushError(''); setWaiverOpen(true); }}` to `ZohoReadinessCard`, and render the dialog beside it:

```tsx
      <ReceiptWaiverDialog
        open={waiverOpen}
        onClose={() => setWaiverOpen(false)}
        onConfirm={(reason) => zohoRetryMutation.mutate(reason)}
        subtitle={`${expense.merchant} · $${expense.amount} · ${expense.user?.name ?? 'Unknown'}`}
        pending={zohoRetryMutation.isPending}
        error={zohoPushError || null}
      />
```

Import `ReceiptWaiverDialog` at the top of the file.

- [ ] **Step 6: Type-check and build**

Run: `cd ~/Work/midas && npm run lint && npm run build`
Expected: clean, build succeeds. The build is the real check that the JSX and imports are sound.

- [ ] **Step 7: Run every suite**

Run: `cd ~/Work/midas && npm run test -w apps/api && npm run test -w apps/web && npx vitest run --root packages/shared && npx vitest run --root packages/ocr-client`
Expected: no suite below its current count

- [ ] **Step 8: Commit**

```bash
cd ~/Work/midas
git add apps/web/src/api/expenses.ts apps/web/src/components/ReceiptWaiverDialog.tsx apps/web/src/pages/AccountantReview.tsx
git commit -m "feat(web): let an accountant push without a receipt by writing why"
```

---

## Task 10: Release

**Files:**
- Modify: `packages/shared/src/version.ts`, `apps/api/package.json`, `apps/web/package.json`, `packages/shared/package.json`
- Modify: `docs/CHANGELOG.md`

**Interfaces:**
- Consumes: every prior task.
- Produces: `GET /api/v1/meta` reporting `1.11.0`.

**Do not merge, tag or push.** A whole-branch review runs before the merge.

- [ ] **Step 1: Bump all four version strings**

`packages/shared/src/version.ts`:

```typescript
export const MIDAS_VERSION = '1.11.0';
```

Set `"version": "1.11.0"` in `apps/api/package.json`, `apps/web/package.json` and `packages/shared/package.json`. `docs/VERSIONING.md` is explicit that these must never disagree.

- [ ] **Step 2: Add the changelog entry**

At the top of `docs/CHANGELOG.md`, matching the existing format:

```markdown
## 1.11.0 (2026-09-10)

### Added
- Accountants can push an approved expense that has no receipt by writing a
  reason. The reason is required, capped at 200 characters, stored on the
  expense, recorded in the audit log, and included in the Zoho Books note as
  "Receipt waived by <name>: <reason>". The button appears only when the missing
  receipt is the sole thing blocking the push.

### Changed
- A missing receipt now blocks a Zoho push on the server, not just in the UI.
  Previously the review page simply hid the push button while the push
  endpoints themselves had no receipt check, so a receipt-less expense could be
  pushed by calling them directly. Every push path now refuses unless the
  expense has a receipt or a recorded waiver.
- A waived expense counts as ready for Zoho, so a waiver whose push then failed
  can be retried from the queue without retyping the reason.

### Database
- Migration `0031_expense_receipt_waiver` adds `receipt_waiver_reason`,
  `receipt_waived_by_id` and `receipt_waived_at` to `expenses`. Additive and
  idempotent; existing rows read as not waived.
```

- [ ] **Step 3: Final verification sweep**

Run: `cd ~/Work/midas && npm run lint && npm run build && npm run test -w apps/api && npm run test -w apps/web && npx vitest run --root packages/shared && npx vitest run --root packages/ocr-client`
Expected: all pass. Record the actual totals — do not claim success without reading the output.

- [ ] **Step 4: Commit**

```bash
cd ~/Work/midas
git add packages/shared/src/version.ts apps/api/package.json apps/web/package.json packages/shared/package.json docs/CHANGELOG.md
git commit -m "chore(release): v1.11.0"
```

---

## Task 11: Deploy

**Repo:** Midas only. The OCR service is untouched and stays on `0.18.0`.

**This release has a migration, and the previous one deliberately did not.** The prod migrator service is broken: its npm script expects a `.env` the image does not carry, and `docker compose run` silently applies nothing unless given `--build`. A migration that appears to run and does not is the worst available outcome, so the columns are verified directly rather than trusting an exit code.

Midas prod is **CT 3120** (`midas-app-prod`), database in **CT 3220**. `/opt/midas` is not a git checkout — deploys are a file copy. `.env` is root-owned and must not be overwritten; `/opt/midas/uploads` is a live bind mount and must not be touched.

- [ ] **Step 1: Confirm the columns are absent before deploying**

```bash
ssh root@192.168.1.190 "pct exec 3120 -- bash -lc 'cd /opt/midas && docker compose -f docker-compose.prod.yml exec -T api node -e \"
  const {Client}=require(\\\"pg\\\");const c=new Client({connectionString:process.env.DATABASE_URL});
  c.connect().then(()=>c.query(\\\"select column_name from information_schema.columns where table_name=\$\$expenses\$\$ and column_name like \$\$receipt_waive%\$\$\\\")).then(r=>{console.log(r.rows);return c.end();});
\"'"
```

Expected: `[]` — no waiver columns yet.

- [ ] **Step 2: Back up prod source and the database**

```bash
ssh root@192.168.1.190 "pct exec 3120 -- bash -lc 'cd /opt && tar czf /opt/midas-backups/source-pre-1.11.0-\$(date +%Y%m%d-%H%M%S).tgz --exclude=midas/uploads --exclude=midas/node_modules midas'"
```

Take a database dump as well — this release adds columns, and a restore path that predates them is the only true rollback for the data.

- [ ] **Step 3: Ship the source**

Build a tarball excluding `.git`, `node_modules`, `dist`, `.env`, `uploads`, `.superpowers`, `.remember` and macOS `._*` files. **Verify the archive contains no `.env` and no `uploads/` before transferring it** — list the archive and confirm both greps are empty. Copy to the host, `pct push` into 3120, and extract *over* the existing tree so `.env` and `uploads` survive. Confirm `.env`'s md5 is unchanged afterwards.

- [ ] **Step 4: Rebuild**

```bash
ssh root@192.168.1.190 "pct exec 3120 -- bash -lc 'cd /opt/midas && docker compose -f docker-compose.prod.yml up -d --build'"
```

Build from `docker-compose.prod.yml` **alone** — the base file or a merged set silently breaks prod.

- [ ] **Step 5: Apply the migration through the runner directly**

Do not rely on the migrator service. Run the SQL runner in the api container, which has both the code and `DATABASE_URL`:

```bash
ssh root@192.168.1.190 "pct exec 3120 -- bash -lc 'cd /opt/midas && docker compose -f docker-compose.prod.yml exec -T api npx tsx src/db/runSqlMigrations.ts'"
```

Expected output includes `apply 0031_expense_receipt_waiver` (or `skip … (already applied)` on a re-run — the runner is idempotent and records each file in `midas_sql_migrations`).

- [ ] **Step 6: Confirm the columns now exist — do not trust the exit code**

Re-run the query from Step 1.
Expected: three rows — `receipt_waiver_reason`, `receipt_waived_by_id`, `receipt_waived_at`.

- [ ] **Step 7: Verify the version**

```bash
ssh root@192.168.1.190 "pct exec 3120 -- curl -s --max-time 10 http://localhost:4000/api/v1/meta"
```

Expected: `"version": "1.11.0"`, and both containers healthy.

- [ ] **Step 8: Walk one waiver end to end**

On the real deployment, as an accountant:

1. Open an approved expense with no receipt where nothing else is missing. Confirm the readiness card offers **Push without receipt…**.
2. Confirm the button does **not** appear on an expense that is also missing a category or an unmapped card.
3. Push with a reason. Confirm it succeeds and the expense shows the waiver in the receipt pane.
4. Open the record in Zoho Books and confirm the note contains `Receipt waived by <name>: <reason>` **and** still contains the merchant name.
5. Confirm the audit log has `expense.receipt_waived` with the reason.
6. **The lane check no test can cover:** confirm a waived expense appears in the `ready_for_zoho` lane — the SQL in `queueLane.ts` is unreachable from the test suite, so this is its only verification.

**Rollback is asymmetric on purpose.** Redeploying the previous image is safe and leaves three unused nullable columns behind, which are harmless. Dropping the columns is destructive — it would discard justifications already written and already sent to Zoho — so it is not part of the rollback.

---

## Self-Review Notes

**Spec coverage:** Component 1 → Task 3; Component 2 → Task 2; Component 3 → Task 6; Component 4 → Task 8; Component 5 → Task 7; Component 6 → Tasks 4 and 5; Component 7 → Tasks 1 and 9; versioning → Task 10; deployment → Task 11.

**Deviation from the spec, corrected here:** the spec's deployment section said to run the migration "through the runner directly, with `--build`", carrying over the `docker compose run --build` advice from the *migrator service*. Exploration showed these are hand-written SQL migrations applied by `src/db/runSqlMigrations.ts`, and the reliable invocation is `exec` into the already-built api container, which is what Task 11 Step 5 does. The spec's `db:generate` framing was never used.

**Type consistency:** `MAX_WAIVER_REASON` is defined once in `packages/shared` (Task 1) and imported by Tasks 2, 8 and 9. `receiptPushBlocker` returns `{ code, status, message } | null` in Task 2 and is destructured as such in Task 6. `PushOptions.receiptWaiver.reason` is defined in Task 6 and passed with that exact shape in Task 8. The column names `receipt_waiver_reason` / `receipt_waived_by_id` / `receipt_waived_at` and their camelCase Drizzle counterparts are identical across Tasks 3, 6, 7 and 9.

**Known gap, stated rather than hidden:** `queueLane.ts`'s SQL is the third expression of the receipt-or-waiver rule and cannot be tested by a DB-free suite. Task 7 adds cross-referencing comments to all three; Task 11 Step 8.6 is its only real verification.
