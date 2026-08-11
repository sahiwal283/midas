# Partner Expenses Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Partner-role users mark an expense business or partner inside the normal expense wizard, and the Partner Expenses tab becomes a reporting view (table + charts) over real expenses instead of a standalone tracker.

**Architecture:** Add `expenses.expense_kind` (`business` | `partner`, default `business`). Partner-kind expenses are excluded from the accountant queue and Zoho push by filtering on that column. The old `partner_expenses` table, routes and create form are deleted (0 rows). The Partner Expenses page gains a server-side summary endpoint feeding three Recharts charts that reuse the Reports page's setup.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL, Express, Vitest, React, TanStack Query, Recharts, Tailwind. Deploy: file-push to CT 3120 per `docs/OPERATIONS.md`; migrations applied by piping SQL to `pct exec 3220 -- su - postgres -c 'psql -d midas'`.

## Global Constraints

- `expense_kind` is a Postgres enum `('business','partner')`, `NOT NULL DEFAULT 'business'`. Every existing expense stays business.
- Only the **partner** role sees the business/partner control; developer passes every role gate via `roleAllowed`. The API coerces `expense_kind` to `'business'` when the submitter is not a partner — never trust the client.
- Partner expenses **never** enter the accountant review queue and **never** push to Zoho. `pushExpenseToZoho` refuses them with an explicit reason rather than skipping silently.
- Partner expenses keep receipts, OCR, categories, payment methods and company.
- The Partner Expenses tab shows **all** partner-kind expenses (not just the viewer's own), gated to `partner`, `admin`, `accountant`, `developer`.
- Charts reuse the Reports page's Recharts imports and its `SERIES` palette so both pages read as one system.
- New-table migrations must set ownership: after `CREATE TABLE` as postgres, run `ALTER TABLE <t> OWNER TO midas` (a table left owned by postgres crash-looped the API on 2026-08-11).
- Version bump: 0.41.1 → 0.42.0 in `apps/api/package.json`, `apps/web/package.json`, `packages/shared/package.json`, and `packages/shared/src/version.ts` (all four must agree — they drifted before).
- Commits end with the standard `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + `Claude-Session` trailer.

---

### Task 1: `expense_kind` column and enum

**Files:**
- Modify: `apps/api/src/db/schema.ts` (add enum near the other `pgEnum` declarations ~line 19–37; add column to `expenses` after `sourceType`)
- Create: `apps/api/drizzle/0023_expense_kind.sql`

**Interfaces:**
- Produces: `expenseKindEnum` (drizzle pgEnum) and `expenses.expenseKind` typed `'business' | 'partner'`. Tasks 2–6 import both from `../db/schema`.

- [ ] **Step 1: Add the enum and column to `schema.ts`**

Alongside the other enums (near `partnerExpenseCategoryEnum`):

```ts
/** Business spend vs partner spend. Partner-kind never enters review or Zoho. */
export const expenseKindEnum = pgEnum('expense_kind', ['business', 'partner']);
```

In the `expenses` table, immediately after `sourceType`:

```ts
  /**
   * 'partner' marks personal/partner spend: tracked and charted, but excluded
   * from the accountant queue and the Zoho pipeline. Set only by partner-role
   * submitters; the API coerces everyone else to 'business'.
   */
  expenseKind: expenseKindEnum('expense_kind').default('business').notNull(),
```

- [ ] **Step 2: Write the migration** `apps/api/drizzle/0023_expense_kind.sql`

```sql
-- 0023: Business vs partner spend on expenses (additive).
-- Partner-kind expenses are excluded from the accountant queue and Zoho push.

DO $$ BEGIN
  CREATE TYPE expense_kind AS ENUM ('business', 'partner');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS expense_kind expense_kind NOT NULL DEFAULT 'business';

CREATE INDEX IF NOT EXISTS expenses_expense_kind_idx ON expenses (expense_kind);
```

- [ ] **Step 3: Type-check**

Run: `cd apps/api && npm run lint`
Expected: clean (`tsc --noEmit` prints nothing).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle/0023_expense_kind.sql
git commit -m "feat(db): expenses.expense_kind — business vs partner spend"
```

---

### Task 2: Pipeline exclusion (TDD)

**Files:**
- Create: `apps/api/src/lib/expenseKind.ts`
- Test: `apps/api/src/__tests__/expenseKind.test.ts`
- Modify: `apps/api/src/routes/accountant.ts:66` (queue `conds`), `:169`, `:253`
- Modify: `apps/api/src/lib/zohoPush.ts` (guard at the top of `pushExpenseToZoho`, before the `zohoEntity` check ~line 43)

**Interfaces:**
- Consumes: `expenses.expenseKind` (Task 1).
- Produces:
  - `resolveExpenseKind(requestedKind: string | null | undefined, role: string): 'business' | 'partner'`
  - `isPartnerExpense(e: { expenseKind?: string | null }): boolean`

- [ ] **Step 1: Write the failing test** `apps/api/src/__tests__/expenseKind.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { resolveExpenseKind, isPartnerExpense } from '../lib/expenseKind';

describe('resolveExpenseKind', () => {
  it('lets a partner mark an expense as partner spend', () => {
    expect(resolveExpenseKind('partner', 'partner')).toBe('partner');
  });

  it('lets a developer mark partner spend (developer passes every gate)', () => {
    expect(resolveExpenseKind('partner', 'developer')).toBe('partner');
  });

  it('coerces to business for non-partner roles even if the client asks for partner', () => {
    expect(resolveExpenseKind('partner', 'user')).toBe('business');
    expect(resolveExpenseKind('partner', 'accountant')).toBe('business');
    expect(resolveExpenseKind('partner', 'admin')).toBe('business');
  });

  it('defaults to business when nothing is requested', () => {
    expect(resolveExpenseKind(undefined, 'partner')).toBe('business');
    expect(resolveExpenseKind(null, 'partner')).toBe('business');
  });

  it('rejects unknown values rather than passing them through', () => {
    expect(resolveExpenseKind('nonsense', 'partner')).toBe('business');
  });
});

describe('isPartnerExpense', () => {
  it('is true only for partner kind', () => {
    expect(isPartnerExpense({ expenseKind: 'partner' })).toBe(true);
    expect(isPartnerExpense({ expenseKind: 'business' })).toBe(false);
    expect(isPartnerExpense({})).toBe(false);
    expect(isPartnerExpense({ expenseKind: null })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/__tests__/expenseKind.test.ts`
Expected: FAIL — cannot find module `../lib/expenseKind`.

- [ ] **Step 3: Implement** `apps/api/src/lib/expenseKind.ts`

```ts
export type ExpenseKind = 'business' | 'partner';

/**
 * Only the partner role may record partner spend. Developer passes every role
 * gate in the app (see lib/roles.ts), so it is allowed too. Anything else — an
 * unknown value, or a non-partner asking for partner — resolves to business.
 * The client is never trusted with this field.
 */
export function resolveExpenseKind(
  requestedKind: string | null | undefined,
  role: string,
): ExpenseKind {
  if (requestedKind !== 'partner') return 'business';
  return role === 'partner' || role === 'developer' ? 'partner' : 'business';
}

/** Partner spend is excluded from the accountant queue and the Zoho pipeline. */
export function isPartnerExpense(e: { expenseKind?: string | null }): boolean {
  return e.expenseKind === 'partner';
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/__tests__/expenseKind.test.ts`
Expected: 8 passed.

- [ ] **Step 5: Exclude partner expenses from the accountant queue**

In `apps/api/src/routes/accountant.ts`, add the import:

```ts
import { expenseKindEnum } from '../db/schema';
```

(`expenses` is already imported.) Then add the filter in all three places that scope to the queue:

Line ~66, the queue `conds` array — change:
```ts
  const conds = [inArray(expenses.status, queueStatuses)];
```
to:
```ts
  // Partner spend is tracked on its own tab and never enters review.
  const conds = [
    inArray(expenses.status, queueStatuses),
    eq(expenses.expenseKind, 'business'),
  ];
```

Line ~169 — change:
```ts
    where: inArray(expenses.status, QUEUE_STATUSES),
```
to:
```ts
    where: and(inArray(expenses.status, QUEUE_STATUSES), eq(expenses.expenseKind, 'business')),
```

Line ~253 — change:
```ts
    .where(inArray(expenses.status, QUEUE_STATUSES));
```
to:
```ts
    .where(and(inArray(expenses.status, QUEUE_STATUSES), eq(expenses.expenseKind, 'business')));
```

`and` and `eq` are already imported in this file — verify with `grep -n "from 'drizzle-orm'" apps/api/src/routes/accountant.ts` and add any missing name.

- [ ] **Step 6: Refuse to push partner expenses to Zoho**

In `apps/api/src/lib/zohoPush.ts`, add the import:

```ts
import { isPartnerExpense } from './expenseKind';
```

and make it the first check inside `pushExpenseToZoho`, before the `zohoEntity` check:

```ts
  if (isPartnerExpense(expense)) {
    return {
      ok: false, status: 409, code: 'PARTNER_EXPENSE_NOT_PUSHABLE',
      message: 'Partner expenses are tracked separately and are never pushed to Zoho',
    };
  }
```

`PushableExpense` already extends `typeof expenses.$inferSelect`, so `expenseKind` is present with no type change.

- [ ] **Step 7: Full suite + lint**

Run: `cd apps/api && npm run test && npm run lint`
Expected: all tests pass (349 existing + 8 new = 357), lint clean.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/lib/expenseKind.ts apps/api/src/__tests__/expenseKind.test.ts apps/api/src/routes/accountant.ts apps/api/src/lib/zohoPush.ts
git commit -m "feat(api): exclude partner expenses from review queue and Zoho push"
```

---

### Task 3: Accept `expenseKind` on expense create/update

**Files:**
- Modify: `apps/api/src/routes/expenses.ts` (create schema + insert ~line 168; update schema + patch)

**Interfaces:**
- Consumes: `resolveExpenseKind` (Task 2).
- Produces: `POST /api/v1/expenses` and `PATCH /api/v1/expenses/:id` accept `expenseKind: 'business' | 'partner'`; the stored value is always the coerced one.

- [ ] **Step 1: Add the import**

```ts
import { resolveExpenseKind } from '../lib/expenseKind';
```

- [ ] **Step 2: Accept the field on create**

In the create body schema (the object containing `categoryId`, `paymentMethodId`, `zohoEntity`), add:

```ts
  /** Partner-role only; coerced to 'business' for every other role. */
  expenseKind: z.enum(['business', 'partner']).optional(),
```

In the insert values (near `categoryId: body.categoryId ?? null` ~line 168), add:

```ts
    expenseKind: resolveExpenseKind(body.expenseKind, req.user!.role),
```

- [ ] **Step 3: Accept the field on update**

In the patch schema add the same optional field, and in the `db.update(expenses).set({...})` object add:

```ts
    ...(body.expenseKind !== undefined
      ? { expenseKind: resolveExpenseKind(body.expenseKind, req.user!.role) }
      : {}),
```

- [ ] **Step 4: Verify a non-partner cannot set it**

Run: `cd apps/api && npm run lint && npm run test`
Expected: clean; the Task 2 unit tests already prove the coercion rule, and this task only wires it in.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/expenses.ts
git commit -m "feat(api): accept expenseKind on expense create and update"
```

---

### Task 4: Partner expenses list + summary endpoints

**Files:**
- Rewrite: `apps/api/src/routes/partnerExpenses.ts` (replace the whole file — it currently serves the standalone table)
- Test: `apps/api/src/__tests__/partnerSummary.test.ts`
- Create: `apps/api/src/lib/partnerSummary.ts`

**Interfaces:**
- Consumes: `expenses.expenseKind` (Task 1).
- Produces:
  - `GET /api/v1/partner-expenses?from=&to=` → `{ expenses: [...] }`
  - `GET /api/v1/partner-expenses/summary?from=&to=` → `{ totals, byCategory, byPeriod, byPerson }`
  - `summarisePartnerRows(rows, nameOf): { name: string; spend: number; count: number }[]` in `lib/partnerSummary.ts`

- [ ] **Step 1: Write the failing test** `apps/api/src/__tests__/partnerSummary.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { summarisePartnerRows } from '../lib/partnerSummary';

describe('summarisePartnerRows', () => {
  it('groups by key, sums spend and counts, sorted by spend descending', () => {
    const rows = [
      { key: 'u1', spend: 50, count: 1 },
      { key: 'u2', spend: 120, count: 2 },
      { key: 'u1', spend: 30, count: 1 },
    ];
    expect(summarisePartnerRows(rows, (k) => ({ u1: 'Ada', u2: 'Grace' }[k] ?? k))).toEqual([
      { name: 'Grace', spend: 120, count: 2 },
      { name: 'Ada', spend: 80, count: 2 },
    ]);
  });

  it('labels a missing key as Unassigned rather than dropping the row', () => {
    expect(summarisePartnerRows([{ key: null, spend: 10, count: 1 }], () => 'x')).toEqual([
      { name: 'Unassigned', spend: 10, count: 1 },
    ]);
  });

  it('returns an empty array for no rows', () => {
    expect(summarisePartnerRows([], () => 'x')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/__tests__/partnerSummary.test.ts`
Expected: FAIL — cannot find module `../lib/partnerSummary`.

- [ ] **Step 3: Implement** `apps/api/src/lib/partnerSummary.ts`

```ts
/** Pure aggregation for the partner expense charts (no db/env imports). */
export function summarisePartnerRows(
  rows: Array<{ key: string | null; spend: number; count: number }>,
  nameOf: (key: string) => string,
): Array<{ name: string; spend: number; count: number }> {
  const acc = new Map<string, { name: string; spend: number; count: number }>();
  for (const r of rows) {
    const k = r.key ?? '__unassigned__';
    const name = r.key ? nameOf(r.key) : 'Unassigned';
    const cur = acc.get(k) ?? { name, spend: 0, count: 0 };
    cur.spend += r.spend;
    cur.count += r.count;
    acc.set(k, cur);
  }
  return [...acc.values()].sort((a, b) => b.spend - a.spend);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/__tests__/partnerSummary.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Rewrite the route file** `apps/api/src/routes/partnerExpenses.ts`

```ts
import { Router } from 'express';
import { and, count, desc, eq, gte, lte, sum } from 'drizzle-orm';
import { db } from '../db/index';
import { expenses, expenseCategories, users } from '../db/schema';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { summarisePartnerRows } from '../lib/partnerSummary';
import { rollUpByTopAncestor } from '../lib/categoryTree';
import { granularityFor, periodKey, fillPeriods } from '../lib/reportBuckets';

const router = Router();
router.use(authenticate, requireRole('partner', 'accountant', 'admin'));

/** Partner spend is shared across partners — everyone permitted sees all of it. */
function scope(from?: string, to?: string) {
  const conds = [eq(expenses.expenseKind, 'partner')];
  if (from) conds.push(gte(expenses.date, from));
  if (to) conds.push(lte(expenses.date, to));
  return and(...conds);
}

function range(req: { query: Record<string, unknown> }) {
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  return { from, to };
}

router.get('/', asyncHandler(async (req, res) => {
  const { from, to } = range(req);
  const rows = await db.query.expenses.findMany({
    where: scope(from, to),
    with: {
      user: { columns: { id: true, name: true, username: true } },
      category: { columns: { id: true, name: true } },
      paymentMethod: { columns: { id: true, label: true, lastFour: true } },
    },
    orderBy: [desc(expenses.date), desc(expenses.createdAt)],
  });
  res.json({ expenses: rows });
}));

router.get('/summary', asyncHandler(async (req, res) => {
  const { from, to } = range(req);
  const where = scope(from, to);
  const num = (v: unknown) => Number(v ?? 0);

  const [totalsRow] = await db.select({ spend: sum(expenses.amount), n: count() })
    .from(expenses).where(where);

  const allCats = await db.query.expenseCategories.findMany({
    columns: { id: true, parentId: true, isActive: true, name: true },
  });
  const byCategoryRaw = await db.select({
    categoryId: expenses.categoryId, spend: sum(expenses.amount), n: count(),
  }).from(expenses).where(where).groupBy(expenses.categoryId);
  const byCategory = rollUpByTopAncestor(
    allCats,
    byCategoryRaw.map((r) => ({ categoryId: r.categoryId, spend: num(r.spend), n: Number(r.n) })),
    (id) => allCats.find((c) => c.id === id)?.name ?? 'Unknown',
  );

  const byUserRaw = await db.select({
    userId: expenses.userId, spend: sum(expenses.amount), n: count(),
  }).from(expenses).where(where).groupBy(expenses.userId);
  const people = await db.query.users.findMany({ columns: { id: true, name: true } });
  const byPerson = summarisePartnerRows(
    byUserRaw.map((r) => ({ key: r.userId, spend: num(r.spend), count: Number(r.n) })),
    (id) => people.find((p) => p.id === id)?.name ?? 'Unknown',
  );

  const byDate = await db.select({ date: expenses.date, spend: sum(expenses.amount), n: count() })
    .from(expenses).where(where).groupBy(expenses.date);
  const granularity = granularityFor(from, to);
  const bucket = new Map<string, number>();
  for (const r of byDate) {
    const key = periodKey(r.date, granularity);
    bucket.set(key, (bucket.get(key) ?? 0) + num(r.spend));
  }
  const byPeriod = fillPeriods(bucket, from, to, granularity);

  res.json({
    totals: { spend: num(totalsRow?.spend), count: Number(totalsRow?.n ?? 0) },
    granularity,
    byCategory,
    byPeriod,
    byPerson,
  });
}));

export default router;
```

Before running, confirm the helper signatures actually match: `grep -n "export function granularityFor\|export function periodKey\|export function fillPeriods" apps/api/src/lib/reportBuckets.ts` and compare with how `routes/reports.ts` calls them (~lines 111–120). Adjust the call sites here to match that file exactly — `reports.ts` is the working reference.

- [ ] **Step 6: Full suite + lint**

Run: `cd apps/api && npm run test && npm run lint`
Expected: pass. If `expenses` has no `paymentMethod`/`category`/`user` relation names matching the `with` block, check `expensesRelations` in `schema.ts` and use the real names.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/partnerExpenses.ts apps/api/src/lib/partnerSummary.ts apps/api/src/__tests__/partnerSummary.test.ts
git commit -m "feat(api): partner expense list and summary over real expenses"
```

---

### Task 5: Remove the old partner_expenses table and its client

**Files:**
- Modify: `apps/api/src/db/schema.ts` (delete `partnerExpenses` table, `partnerExpensesRelations`, `partnerExpenseCategoryEnum`)
- Create: `apps/api/drizzle/0024_drop_partner_expenses.sql`
- Modify: `apps/web/src/api/partnerExpenses.ts` (delete file), `packages/shared/src/types/index.ts` (remove `PartnerExpense`, `PartnerExpenseCategory` exports), `apps/web/src/types/index.ts` (same)

**Interfaces:**
- Produces: nothing. This removes the dead standalone path so there is one way to log an expense.

- [ ] **Step 1: Write the drop migration** `apps/api/drizzle/0024_drop_partner_expenses.sql`

```sql
-- 0024: Remove the standalone partner expense tracker.
-- Partner spend is now expenses.expense_kind = 'partner'. The table held 0 rows.

DROP TABLE IF EXISTS partner_expenses;
DROP TYPE IF EXISTS partner_expense_category;
```

- [ ] **Step 2: Delete the schema definitions**

Remove from `apps/api/src/db/schema.ts`: the `partnerExpenses` table block, the `partnerExpensesRelations` block, and the `partnerExpenseCategoryEnum` declaration.

- [ ] **Step 3: Delete the web client and shared types**

```bash
rm apps/web/src/api/partnerExpenses.ts
```

Remove `PartnerExpense` and `PartnerExpenseCategory` from the export list in `packages/shared/src/types/index.ts` and from `apps/web/src/types/index.ts`, and delete their interface/type declarations in `packages/shared/src/types/index.ts`.

- [ ] **Step 4: Find every remaining reference**

Run: `grep -rn "partnerExpense\|PartnerExpense\|partner_expense" apps/api/src apps/web/src packages/shared/src --include=*.ts --include=*.tsx | grep -v "partner-expenses"`
Expected: only `routes/partnerExpenses.ts` (the rewritten file) and `pages/PartnerExpenses.tsx` (rewritten in Task 6). Fix anything else the compiler flags.

- [ ] **Step 5: Type-check both workspaces**

Run: `cd apps/api && npm run lint && cd ../web && npm run lint`
Expected: clean. Task 6 rewrites `PartnerExpenses.tsx`; if it still imports the deleted client, do Task 6 before this step passes.

- [ ] **Step 6: Commit**

```bash
git add -A apps packages
git commit -m "refactor: drop the standalone partner_expenses tracker"
```

---

### Task 6: Expense form toggle + Partner Expenses page

**Files:**
- Modify: `apps/web/src/pages/ExpenseNew.tsx` (form state; a new Field before Notes)
- Modify: `apps/web/src/api/expenses.ts` (add `expenseKind` to the `create`/`update` payload types)
- Rewrite: `apps/web/src/pages/PartnerExpenses.tsx`

**Interfaces:**
- Consumes: `GET /partner-expenses`, `GET /partner-expenses/summary` (Task 4); `expenseKind` on create (Task 3).

- [ ] **Step 1: Add `expenseKind` to the API client types**

In `apps/web/src/api/expenses.ts`, add to both the `create` data type and the `update` data type:

```ts
    expenseKind?: 'business' | 'partner';
```

- [ ] **Step 2: Add the toggle to the wizard**

In `apps/web/src/pages/ExpenseNew.tsx`, add `expenseKind: 'business' as 'business' | 'partner',` to the `form` useState object. Import the auth hook if not already present (`useAuth` is already imported). Then add this Field immediately before the "Notes (optional)" Field:

```tsx
          {(user?.role === 'partner' || user?.role === 'developer') && (
            <Field label="Expense type">
              <div className="flex gap-2">
                {(['business', 'partner'] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => set('expenseKind', kind)}
                    className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                      form.expenseKind === kind
                        ? 'border-brand-500 bg-brand-500/10 text-ink'
                        : 'border-ink/15 text-charcoal/60 hover:bg-ink/[0.03]'
                    }`}
                  >
                    {kind === 'business' ? 'Business expense' : 'Partner expense'}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-charcoal/40">
                Partner expenses are tracked on the Partner Expenses tab and are not sent to accounting.
              </p>
            </Field>
          )}
```

In `doSubmit`, add to the payload:

```ts
        expenseKind: form.expenseKind,
```

`set` is typed `(key: string, value: string)`; if TypeScript complains about the union, widen the call to `set('expenseKind', kind)` by changing `set`'s signature to `(key: string, value: string)` → it already accepts a string, and `kind` is a string literal, so this compiles. Verify with `npm run lint`.

- [ ] **Step 3: Rewrite the Partner Expenses page** `apps/web/src/pages/PartnerExpenses.tsx`

```tsx
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell,
} from 'recharts';
import client from '../api/client';

/** Same fixed-slot palette as the Reports page so both read as one system. */
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const GRID = '#f3f4f6';
const INK_MUTED = '#6b7280';

interface PartnerRow {
  id: string;
  date: string;
  merchant: string;
  amount: string;
  user?: { name: string } | null;
  category?: { name: string } | null;
  paymentMethod?: { label: string; lastFour: string | null } | null;
}

interface Summary {
  totals: { spend: number; count: number };
  granularity: string;
  byCategory: Array<{ name: string; spend: number; n: number }>;
  byPeriod: Array<{ label: string; spend: number }>;
  byPerson: Array<{ name: string; spend: number; count: number }>;
}

const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-ink/10 bg-white p-5 shadow-panel">
      <h2 className="mb-4 border-b border-gold-400/60 pb-2.5 text-sm font-semibold text-charcoal/80">{title}</h2>
      {children}
    </div>
  );
}

export function PartnerExpenses() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const params = useMemo(() => {
    const p: Record<string, string> = {};
    if (from) p.from = from;
    if (to) p.to = to;
    return p;
  }, [from, to]);

  const { data: rows = [], isLoading } = useQuery<PartnerRow[]>({
    queryKey: ['partner-expenses', params],
    queryFn: () => client.get('/partner-expenses', { params }).then((r) => r.data.expenses),
  });
  const { data: summary } = useQuery<Summary>({
    queryKey: ['partner-expenses-summary', params],
    queryFn: () => client.get('/partner-expenses/summary', { params }).then((r) => r.data),
  });

  return (
    <div className="p-4 lg:p-8">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold text-ink">Partner Expenses</h1>
        <p className="mt-1 text-sm text-charcoal/55">
          Spend marked as partner expenses. Not sent to accounting or Zoho.
        </p>
      </div>

      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-charcoal/60" htmlFor="pe-from">From</label>
          <input id="pe-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="rounded-lg border border-ink/15 px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-charcoal/60" htmlFor="pe-to">To</label>
          <input id="pe-to" type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="rounded-lg border border-ink/15 px-3 py-2 text-sm" />
        </div>
        {summary && (
          <p className="ml-auto text-sm text-charcoal/60">
            <span className="font-display text-2xl font-semibold text-ink">{money(summary.totals.spend)}</span>
            <span className="ml-2">across {summary.totals.count} expense{summary.totals.count === 1 ? '' : 's'}</span>
          </p>
        )}
      </div>

      {summary && summary.totals.count > 0 && (
        <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card title="Spend by category">
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={summary.byCategory} dataKey="spend" nameKey="name" innerRadius={50} outerRadius={90}>
                  {summary.byCategory.map((_, i) => <Cell key={i} fill={SERIES[i % SERIES.length]} />)}
                </Pie>
                <Tooltip formatter={(v: number) => money(v)} />
              </PieChart>
            </ResponsiveContainer>
          </Card>

          <Card title="Spend over time">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={summary.byPeriod} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="label" tick={{ fill: INK_MUTED, fontSize: 12 }} tickLine={false} />
                <YAxis tick={{ fill: INK_MUTED, fontSize: 12 }} tickLine={false} axisLine={false} />
                <Tooltip formatter={(v: number) => money(v)} />
                <Bar dataKey="spend" fill={SERIES[0]} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>

          <Card title="Spend by individual">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={summary.byPerson} layout="vertical" margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid stroke={GRID} horizontal={false} />
                <XAxis type="number" tick={{ fill: INK_MUTED, fontSize: 12 }} tickLine={false} />
                <YAxis type="category" dataKey="name" width={100} tick={{ fill: INK_MUTED, fontSize: 12 }} tickLine={false} axisLine={false} />
                <Tooltip formatter={(v: number) => money(v)} />
                <Bar dataKey="spend" fill={SERIES[2]} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-ink/10 bg-white shadow-panel">
        {isLoading ? (
          <p className="px-6 py-8 text-center text-sm text-charcoal/40">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-charcoal/40">
            No partner expenses yet. Submit an expense and choose “Partner expense”.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink/10 text-left text-xs font-semibold uppercase tracking-wider text-charcoal/45">
                <th className="px-6 py-3">Date</th>
                <th className="px-6 py-3">Individual</th>
                <th className="px-6 py-3">Merchant</th>
                <th className="px-6 py-3">Category</th>
                <th className="px-6 py-3">Payment</th>
                <th className="px-6 py-3 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-ink/5 last:border-0">
                  <td className="px-6 py-3 text-charcoal/70">{r.date}</td>
                  <td className="px-6 py-3 text-ink">{r.user?.name ?? '—'}</td>
                  <td className="px-6 py-3 text-ink">{r.merchant}</td>
                  <td className="px-6 py-3 text-charcoal/70">{r.category?.name ?? '—'}</td>
                  <td className="px-6 py-3 text-charcoal/70">
                    {r.paymentMethod ? `${r.paymentMethod.label}${r.paymentMethod.lastFour ? ` ····${r.paymentMethod.lastFour}` : ''}` : '—'}
                  </td>
                  <td className="px-6 py-3 text-right font-semibold text-ink">{money(Number(r.amount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Widen the route gate**

In `apps/web/src/App.tsx` line ~60, change:
```tsx
<ProtectedRoute roles={['partner', 'developer']}>
```
to:
```tsx
<ProtectedRoute roles={['partner', 'accountant', 'admin', 'developer']}>
```
so it matches the API gate from Task 4.

- [ ] **Step 5: Type-check and build**

Run: `cd apps/web && npm run lint && npm run build`
Expected: clean, build succeeds. If `byPeriod` items are not `{label, spend}`, match the real shape returned by `fillPeriods` (check how `Reports.tsx` line ~307 consumes it).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/ExpenseNew.tsx apps/web/src/pages/PartnerExpenses.tsx apps/web/src/api/expenses.ts apps/web/src/App.tsx
git commit -m "feat(web): partner/business toggle and partner expense charts"
```

---

### Task 7: Verify against real data, deploy

**Files:**
- Modify: `apps/api/package.json:3`, `apps/web/package.json:3`, `packages/shared/package.json:3`, `packages/shared/src/version.ts` → `0.42.0`

- [ ] **Step 1: Rehearse the migrations on a copy of the live database**

```bash
ssh root@192.168.1.190 "pct exec 3220 -- su - postgres -c 'pg_dump -d midas'" > /tmp/snap.sql
dropdb -h 127.0.0.1 midas_pe_test 2>/dev/null; createdb -h 127.0.0.1 midas_pe_test
psql -q postgresql://sahilkhatri@127.0.0.1:5432/midas_pe_test -f /tmp/snap.sql
psql postgresql://sahilkhatri@127.0.0.1:5432/midas_pe_test -f apps/api/drizzle/0023_expense_kind.sql
psql postgresql://sahilkhatri@127.0.0.1:5432/midas_pe_test -f apps/api/drizzle/0024_drop_partner_expenses.sql
psql postgresql://sahilkhatri@127.0.0.1:5432/midas_pe_test -c "select expense_kind, count(*) from expenses group by 1"
```
Expected: every existing expense reports `business`; no errors.

- [ ] **Step 2: Prove the pipeline exclusion with a real API call**

Start the API against the test copy, mark one expense partner, and confirm it leaves the queue:

```bash
cd apps/api
psql postgresql://sahilkhatri@127.0.0.1:5432/midas_pe_test -c "update expenses set expense_kind='partner' where id=(select id from expenses where status='pending' limit 1)"
DATABASE_URL=postgresql://sahilkhatri@127.0.0.1:5432/midas_pe_test JWT_SECRET=pe-test-secret-at-least-32-chars-ok AUTH_MODE=local OCR_MODE=mock ZOHO_MODE=mock STORAGE_MODE=local UPLOADS_DIR=./uploads PORT=4094 COOKIE_SECURE=false npx tsx src/server.ts &
# log in as a seeded admin, then:
#   GET /api/v1/accountant/queue      → the partner expense must be absent
#   GET /api/v1/partner-expenses      → it must be present
#   GET /api/v1/partner-expenses/summary → totals.count === 1
```
Expected: the expense appears only on the partner side. Stop the server and `dropdb midas_pe_test` when done.

- [ ] **Step 3: Bump versions, run all checks, merge, push**

```bash
sed -i '' 's/"version": "0.41.1"/"version": "0.42.0"/' apps/api/package.json apps/web/package.json packages/shared/package.json
sed -i '' "s/export const MIDAS_VERSION = '.*';/export const MIDAS_VERSION = '0.42.0';/" packages/shared/src/version.ts
(cd apps/api && npm run lint && npm run test) && (cd apps/web && npm run lint && npm run build)
git add -A apps packages
git commit -m "chore: bump version to 0.42.0"
git checkout main && git merge --no-ff <feature-branch> && git push origin main
```

- [ ] **Step 4: Deploy to CT 3120 and apply the migrations**

```bash
tar czf /tmp/pe.tgz apps/api/src apps/api/drizzle/0023_expense_kind.sql apps/api/drizzle/0024_drop_partner_expenses.sql \
  apps/web/src apps/api/package.json apps/web/package.json packages/shared/src packages/shared/package.json
scp /tmp/pe.tgz root@192.168.1.190:/tmp/
ssh root@192.168.1.190 "pct push 3120 /tmp/pe.tgz /tmp/d.tgz && pct exec 3120 -- bash -c 'cd /opt/midas && tar xzf /tmp/d.tgz; rm -f /tmp/d.tgz; find . -name \"._*\" -delete'"

# migrations (0023 then 0024) — no new tables, so no OWNER TO step needed here
for m in 0023_expense_kind 0024_drop_partner_expenses; do
  ssh root@192.168.1.190 "pct exec 3120 -- cat /opt/midas/apps/api/drizzle/$m.sql" > /tmp/$m.sql
  ssh root@192.168.1.190 "pct exec 3220 -- su - postgres -c 'psql -d midas'" < /tmp/$m.sql
  rm -f /tmp/$m.sql
done

ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose up -d --no-deps --build api'"
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose -f docker-compose.prod.yml up -d --no-deps --build web'"
```

- [ ] **Step 5: Verify in production**

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://midas.booute.duckdns.org/          # 200
ssh root@192.168.1.190 "pct exec 3120 -- curl -s http://localhost:4000/api/v1/meta"  # 0.42.0
ssh root@192.168.1.190 "pct exec 3220 -- su - postgres -c \"psql -d midas -c 'select expense_kind, count(*) from expenses group by 1'\""
ssh root@192.168.1.190 "pct exec 3220 -- su - postgres -c \"psql -d midas -Atc \\\"select count(*) from information_schema.tables where table_name='partner_expenses'\\\"\""  # 0
```
Expected: 378 business / 0 partner, `partner_expenses` gone, API on 0.42.0, web 200.

- [ ] **Step 6: Report** — what moved, that all existing expenses stayed business, and that partner expenses are excluded from review and Zoho.
