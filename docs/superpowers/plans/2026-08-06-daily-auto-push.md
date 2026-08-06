# Daily Expense Auto-Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete staff-entered daily expenses auto-approve and push to Zoho on submit; Trade Show / incomplete expenses keep accountant approval.

**Architecture:** Pure eligibility check in `lib/autoApprove.ts`; the accountant route's inline Zoho push extracted behavior-identically into `lib/zohoPush.ts` and shared by both the accountant route and the new auto-push branch in `POST /expenses/:id/submit`. Readiness at submit is evaluated with status treated as `approved` ("ready once approved") because `evaluateZohoReadiness` requires approved status.

**Tech Stack:** Express + Drizzle + Vitest.

**Spec:** `docs/superpowers/specs/2026-08-06-daily-expense-auto-push-design.md`

## Global Constraints

- Eligible iff `(sourceApp === null || sourceApp === 'browser_extension') && ready`.
- `trade_show` / any other sourceApp: NEVER eligible.
- Audit action for auto-approval: `auto_approved` (userId = submitter, `reviewedById` stays null).
- Accountant `POST /expenses/:id/zoho-push` contract must not change (same 409 codes: `MISSING_ZOHO_ENTITY`, `MISSING_CATEGORY`, `MISSING_PAYMENT_METHOD`, `MISSING_ZOHO_EXPENSE_ACCOUNT`, `MISSING_ZOHO_PAID_THROUGH`; same 502 shape on push failure).
- Submit returns 200 with the expense even when the auto-push fails (expense lands in `zoho_sync_failed` for the accountant retry lane).
- Suite has 2 pre-existing failures (`zohoReadiness`, `mapOcrError`) — not regressions.

---

### Task 1: Eligibility lib

**Files:**
- Create: `apps/api/src/lib/autoApprove.ts`
- Test: `apps/api/src/__tests__/autoApprove.test.ts`

**Interfaces:**
- Produces: `isAutoPushEligible(i: { sourceApp: string | null; ready: boolean }): boolean`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { isAutoPushEligible } from '../lib/autoApprove';

describe('isAutoPushEligible', () => {
  it('eligible: Midas-entered (null source) and ready', () => {
    expect(isAutoPushEligible({ sourceApp: null, ready: true })).toBe(true);
  });
  it('eligible: browser extension and ready', () => {
    expect(isAutoPushEligible({ sourceApp: 'browser_extension', ready: true })).toBe(true);
  });
  it('not eligible when not ready', () => {
    expect(isAutoPushEligible({ sourceApp: null, ready: false })).toBe(false);
  });
  it('never eligible for trade_show or other external sources, even when ready', () => {
    expect(isAutoPushEligible({ sourceApp: 'trade_show', ready: true })).toBe(false);
    expect(isAutoPushEligible({ sourceApp: 'milo', ready: true })).toBe(false);
  });
});
```

- [ ] **Step 2:** Run `npm run test -- src/__tests__/autoApprove.test.ts` (in `apps/api`) → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
/** Daily-expense auto-push: complete staff-entered expenses skip accountant approval. */

const AUTO_PUSH_SOURCES = new Set<string | null>([null, 'browser_extension']);

/** Event/external expenses (trade_show, …) always require accountant approval. */
export function isAutoPushEligible(i: { sourceApp: string | null; ready: boolean }): boolean {
  return AUTO_PUSH_SOURCES.has(i.sourceApp) && i.ready;
}
```

- [ ] **Step 4:** Re-run → PASS (4 tests).
- [ ] **Step 5:** Commit: `git add apps/api/src/lib/autoApprove.ts apps/api/src/__tests__/autoApprove.test.ts && git commit -m "feat(api): auto-push eligibility check"`

---

### Task 2: Extract shared push into `lib/zohoPush.ts`

**Files:**
- Create: `apps/api/src/lib/zohoPush.ts`
- Modify: `apps/api/src/routes/accountant.ts` (`POST /expenses/:id/zoho-push` handler body + imports)

**Interfaces:**
- Consumes: `zoho, ZohoServiceError` (`../lib/zoho`), `buildZohoServicePayload` (`../lib/zohoPayload`), `auditLog`, drizzle `expenses`.
- Produces:

```ts
export type ZohoPushOutcome =
  | { ok: true; expense: typeof expenses.$inferSelect; zoho: ZohoPushResult }
  | { ok: false; status: 409 | 502; code: string; message: string; requestId?: string };
export async function pushExpenseToZoho(expense: PushableExpense, actorUserId: string): Promise<ZohoPushOutcome>
// PushableExpense = expense row + { receipts: {id}[]; category: {id,name,zohoAccountId}|null; paymentMethod: {id,label,zohoAccountName}|null }
```

- [ ] **Step 1: Create the lib** — move the validation + try/catch from the accountant handler verbatim, returning outcomes instead of throwing/responding:

```ts
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { expenses } from '../db/schema';
import { auditLog } from './audit';
import { zoho, ZohoServiceError, type ZohoPushResult } from './zoho';
import { buildZohoServicePayload, type PayloadExpense } from './zohoPayload';

export type PushableExpense = PayloadExpense & typeof expenses.$inferSelect;

export type ZohoPushOutcome =
  | { ok: true; expense: typeof expenses.$inferSelect; zoho: ZohoPushResult }
  | { ok: false; status: 409 | 502; code: string; message: string; requestId?: string };

/** Validates and pushes one expense to Zoho. On success sets approved+synced;
 *  on push failure sets zoho_sync_failed. Used by the accountant route and
 *  by daily-expense auto-push on submit. */
export async function pushExpenseToZoho(expense: PushableExpense, actorUserId: string): Promise<ZohoPushOutcome> {
  if (!expense.zohoEntity) {
    return { ok: false, status: 409, code: 'MISSING_ZOHO_ENTITY', message: 'zohoEntity must be set before pushing to Zoho' };
  }
  if (!expense.categoryId && !expense.zohoExpenseAccountId) {
    return { ok: false, status: 409, code: 'MISSING_CATEGORY', message: 'Category must be set before pushing to Zoho' };
  }
  if (!expense.paymentMethodId) {
    return { ok: false, status: 409, code: 'MISSING_PAYMENT_METHOD', message: 'Payment method must be set before pushing to Zoho' };
  }

  const payload = buildZohoServicePayload(expense);
  if (!payload.account_id) {
    return { ok: false, status: 409, code: 'MISSING_ZOHO_EXPENSE_ACCOUNT', message: 'No Zoho expense account on this expense — select one from the Zoho COA (or map a Trade Show category)' };
  }
  if (!payload.paid_through_account_id) {
    return { ok: false, status: 409, code: 'MISSING_ZOHO_PAID_THROUGH', message: 'Payment method has no Zoho paid-through account id (Admin → Payment Methods → Zoho Account)' };
  }

  try {
    const result = await zoho.pushExpense(payload);
    const [updated] = await db.update(expenses)
      .set({ status: 'approved', zohoExpenseId: result.zohoExpenseId, zohoSyncedAt: result.syncedAt, updatedAt: new Date() })
      .where(eq(expenses.id, expense.id))
      .returning();
    await auditLog({
      entityType: 'expense', entityId: expense.id, userId: actorUserId,
      action: 'zoho.pushed', after: result,
      metadata: { idempotencyKey: payload.idempotencyKey, dryRun: result.dryRun ?? false },
    });
    return { ok: true, expense: updated, zoho: result };
  } catch (err) {
    await db.update(expenses)
      .set({ status: 'zoho_sync_failed', updatedAt: new Date() })
      .where(eq(expenses.id, expense.id));
    const zohoErr = err instanceof ZohoServiceError ? err : null;
    await auditLog({
      entityType: 'expense', entityId: expense.id, userId: actorUserId,
      action: 'zoho.failed',
      metadata: { error: zohoErr?.message ?? String(err), code: zohoErr?.code ?? 'ZOHO_SYNC_FAILED', requestId: zohoErr?.requestId ?? null },
    });
    const message = zohoErr?.code === 'ZOHO_AUTH_INVALID'
      ? 'Zoho Integration Service rejected Midas credentials (inbound auth). Check Authorization: Bearer token. Expense marked for retry.'
      : zohoErr?.code === 'ZOHO_AUTH_FORBIDDEN'
        ? 'Midas is not granted this Zoho brand/capability. Contact the Zoho Integration Service team. Expense marked for retry.'
        : 'Zoho push failed — expense marked for retry.';
    return { ok: false, status: 502, code: zohoErr?.code ?? 'ZOHO_SYNC_FAILED', message, requestId: zohoErr?.requestId ?? undefined };
  }
}
```

**Fidelity notes:** the original handler's `MISSING_CATEGORY` check is `!expense.categoryId` alone, but `buildZohoServicePayload` also accepts `zohoExpenseAccountId` — mirror the original exactly if unsure (`!expense.categoryId`) UNLESS the daily flow relies on COA-only expenses; the New Expense form sets `zohoExpenseAccountId` without category, so use the `!categoryId && !zohoExpenseAccountId` form and verify the accountant route still behaves for its cases (account_id check catches the rest anyway).

- [ ] **Step 2: Rewire the accountant handler** to load the expense (unchanged query), keep the status gate (`approved`/`zoho_sync_failed` else 409 CONFLICT), then:

```ts
  const outcome = await pushExpenseToZoho(expense, req.user!.id);
  if (outcome.ok) {
    res.json({ expense: outcome.expense, zoho: outcome.zoho });
    return;
  }
  if (outcome.status === 409) throw createError(outcome.message, 409, outcome.code);
  res.status(502).json({ error: { code: outcome.code, message: outcome.message, requestId: outcome.requestId } });
```

Remove the now-unused `zoho`/`ZohoServiceError`/`buildZohoServicePayload` imports from `accountant.ts` if nothing else uses them (grep first — service-health probe may).

- [ ] **Step 3:** `npm run lint` + `npm run test` (in `apps/api`) → clean / no new failures.
- [ ] **Step 4:** Commit: `git add apps/api/src/lib/zohoPush.ts apps/api/src/routes/accountant.ts && git commit -m "refactor(api): extract shared Zoho push into lib/zohoPush"`

---

### Task 3: Auto-push on submit

**Files:**
- Modify: `apps/api/src/routes/expenses.ts` (`POST /:id/submit`, imports)

**Interfaces:**
- Consumes: `isAutoPushEligible` (Task 1), `pushExpenseToZoho` (Task 2), `evaluateZohoReadiness` from `../lib/zohoReadiness`.

- [ ] **Step 1: Rewrite the submit handler**

```ts
router.post('/:id/submit', asyncHandler(async (req, res) => {
  const expense = await db.query.expenses.findFirst({
    where: eq(expenses.id, req.params.id),
    with: {
      receipts: true,
      category: { columns: { id: true, name: true, zohoAccountId: true } },
      paymentMethod: { columns: { id: true, label: true, zohoAccountName: true } },
      messages: { columns: { requestType: true, isResolved: true } },
    },
  });
  if (!expense) throw notFound('Expense not found');
  if (expense.userId !== req.user!.id) throw forbidden();
  if (expense.status !== 'draft') {
    res.status(409).json({ error: { code: 'CONFLICT', message: 'Expense is not in draft status' } });
    return;
  }

  // Daily auto-push: complete staff-entered expenses skip accountant approval.
  // Readiness is evaluated as-if approved ("ready once approved").
  const readiness = evaluateZohoReadiness({ ...expense, status: 'approved' });
  if (isAutoPushEligible({ sourceApp: expense.sourceApp, ready: readiness.ready })) {
    const [approved] = await db.update(expenses)
      .set({ status: 'approved', updatedAt: new Date() })
      .where(eq(expenses.id, expense.id))
      .returning();
    await auditLog({
      entityType: 'expense', entityId: expense.id, userId: req.user!.id,
      action: 'auto_approved',
      before: { status: 'draft' }, after: { status: 'approved' },
      metadata: { reason: 'complete daily expense', zohoMode: readiness.zohoMode },
    });
    const outcome = await pushExpenseToZoho({ ...expense, ...approved }, req.user!.id);
    // Push failure → expense is zoho_sync_failed (set by the lib) and lands in
    // the accountant retry lane; the submitter's part is done either way.
    res.json({ expense: outcome.ok ? outcome.expense : { ...approved, status: 'zoho_sync_failed' }, autoPushed: outcome.ok });
    return;
  }

  const [updated] = await db.update(expenses)
    .set({ status: 'pending', updatedAt: new Date() })
    .where(eq(expenses.id, req.params.id))
    .returning();

  await auditLog({ entityType: 'expense', entityId: expense.id, userId: req.user!.id, action: 'submitted', before: { status: 'draft' }, after: { status: 'pending' } });

  res.json({ expense: updated });
}));
```

Add imports: `evaluateZohoReadiness` from `../lib/zohoReadiness`, `isAutoPushEligible` from `../lib/autoApprove`, `pushExpenseToZoho` from `../lib/zohoPush`.

- [ ] **Step 2:** `npm run lint` + `npm run test` (in `apps/api`) → clean / no new failures.
- [ ] **Step 3:** Commit: `git add apps/api/src/routes/expenses.ts && git commit -m "feat(api): auto-approve and push complete daily expenses on submit"`

---

### Task 4: Verify, version, ship

- [ ] **Step 1:** Repo root `npm run lint` → 0 errors; `apps/api` `npm run test` → only 2 pre-existing failures.
- [ ] **Step 2:** Bump 0.5.1-alpha → 0.6.0-alpha (3 package.json + `packages/shared/src/version.ts`), CHANGELOG entry, commit `chore: bump version to 0.6.0-alpha`.
- [ ] **Step 3:** Merge to main, push, deploy per OPERATIONS.md (API source push → tsx hot reload; no web change, no schema change), verify `/api/v1/meta` shows 0.6.0-alpha, smoke-test a submit in prod, report.
