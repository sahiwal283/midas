# Partner Expense Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standalone partner-expense tracker (table + simple intake form) visible only to the new `partner` role, with a new all-access `developer` role.

**Architecture:** Two new enum values on `user_role`; developer bypass implemented once in `requireRole` (API) and `ProtectedRoute` (web). New standalone `partner_expenses` table with its own router at `/api/v1/partner-expenses` — no coupling to receipts/queues/Zoho. One new web page mirroring the My Expenses table style.

**Tech Stack:** Drizzle ORM + drizzle-kit migrations, Express + zod, React + TanStack Query + Tailwind, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-06-partner-expenses-design.md`

## Global Constraints

- Roles enum becomes exactly: `'user' | 'accountant' | 'admin' | 'partner' | 'developer'`.
- `developer` passes every role gate; `admin` scope is unchanged.
- Partner expense category enum: `business | personal`, default `business`.
- Seed users: `partner@midas.local` / `partner123`, `developer@midas.local` / `developer123`.
- Tests are Vitest, no DB (`apps/api`: `npm run test`). Web verification is `npm run lint` (tsc).
- **Dirty-tree caveat:** `apps/api/src/db/schema.ts`, `packages/shared/src/types/index.ts`, and `docs/CHANGELOG.md` already carry uncommitted WIP from other work. Commits in this plan that include those files will carry that WIP along — acceptable (solo sprint on main), but say so in the final report.
- All `npm` commands run from the workspace subdirectory named in the step (`apps/api`, `apps/web`, or repo root).

---

### Task 1: Roles — enum, shared type, developer bypass, seed users

**Files:**
- Create: `apps/api/src/lib/roles.ts`
- Test: `apps/api/src/__tests__/roles.test.ts`
- Modify: `packages/shared/src/types/index.ts:5`
- Modify: `apps/api/src/db/schema.ts:19`
- Modify: `apps/api/src/middleware/auth.ts:57-69`
- Modify: `apps/api/src/db/seed.ts:101-105`
- Create (generated): `apps/api/drizzle/0008_*.sql`

**Interfaces:**
- Produces: `roleAllowed(role: UserRole, allowed: UserRole[]): boolean` from `../lib/roles` — developer always passes. `UserRole` union gains `'partner' | 'developer'`. Later tasks rely on `requireRole('partner')` admitting developers automatically.

- [ ] **Step 1: Write the failing test**

`apps/api/src/__tests__/roles.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { roleAllowed } from '../lib/roles';

describe('roleAllowed', () => {
  it('allows a listed role', () => {
    expect(roleAllowed('partner', ['partner'])).toBe(true);
  });

  it('rejects an unlisted role', () => {
    expect(roleAllowed('user', ['partner'])).toBe(false);
    expect(roleAllowed('admin', ['partner'])).toBe(false);
  });

  it('developer passes every gate', () => {
    expect(roleAllowed('developer', ['partner'])).toBe(true);
    expect(roleAllowed('developer', ['admin'])).toBe(true);
    expect(roleAllowed('developer', ['accountant', 'admin'])).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (in `apps/api`): `npm run test -- src/__tests__/roles.test.ts`
Expected: FAIL — cannot resolve `../lib/roles` (and `'partner'`/`'developer'` are type errors until Step 3).

- [ ] **Step 3: Implement**

`packages/shared/src/types/index.ts` line 5:

```ts
export type UserRole = 'user' | 'accountant' | 'admin' | 'partner' | 'developer';
```

`apps/api/src/db/schema.ts` line 19:

```ts
export const userRoleEnum = pgEnum('user_role', ['user', 'accountant', 'admin', 'partner', 'developer']);
```

New `apps/api/src/lib/roles.ts`:

```ts
import type { UserRole } from '@midas/shared';

/** Developer is an all-access role: it passes every role gate in the app. */
export function roleAllowed(role: UserRole, allowed: UserRole[]): boolean {
  if (role === 'developer') return true;
  return allowed.includes(role);
}
```

`apps/api/src/middleware/auth.ts` — replace the body of `requireRole` (keep signature):

```ts
import { roleAllowed } from '../lib/roles';

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });
      return;
    }
    if (!roleAllowed(req.user.role, roles)) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } });
      return;
    }
    next();
  };
}
```

`apps/api/src/db/seed.ts` — extend `defaultUsers`:

```ts
    { email: 'partner@midas.local', name: 'Partner User', role: 'partner' as const, password: 'partner123' },
    { email: 'developer@midas.local', name: 'Developer User', role: 'developer' as const, password: 'developer123' },
```

- [ ] **Step 4: Run test to verify it passes**

Run (in `apps/api`): `npm run test -- src/__tests__/roles.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Generate migration**

Run (in `apps/api`): `npm run db:generate`
Expected: new file `apps/api/drizzle/0008_*.sql` containing two `ALTER TYPE "public"."user_role" ADD VALUE` statements.

- [ ] **Step 6: Lint + commit**

Run (in `apps/api`): `npm run lint` — expect clean. Then:

```bash
git add apps/api/src/lib/roles.ts apps/api/src/__tests__/roles.test.ts \
  apps/api/src/middleware/auth.ts apps/api/src/db/seed.ts \
  apps/api/src/db/schema.ts packages/shared/src/types/index.ts apps/api/drizzle
git commit -m "feat(api): add partner and developer roles; developer passes all role gates"
```

(Note: `schema.ts` / shared `types/index.ts` carry pre-existing WIP hunks — expected per Global Constraints.)

---

### Task 2: `partner_expenses` table + validation lib

**Files:**
- Create: `apps/api/src/lib/partnerExpenses.ts`
- Test: `apps/api/src/__tests__/partnerExpenses.test.ts`
- Modify: `apps/api/src/db/schema.ts` (new enum + table + relations, after the `expenses` section)
- Create (generated): `apps/api/drizzle/0009_*.sql`

**Interfaces:**
- Produces: schema exports `partnerExpenseCategoryEnum`, `partnerExpenses`, `partnerExpensesRelations`; lib exports `partnerExpenseCreateSchema` (zod) parsing `{ amount: number > 0, itemLocation: trimmed non-empty string ≤ 300, category?: 'business' | 'personal' }` with category defaulting to `'business'`.

- [ ] **Step 1: Write the failing test**

`apps/api/src/__tests__/partnerExpenses.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { partnerExpenseCreateSchema } from '../lib/partnerExpenses';

describe('partnerExpenseCreateSchema', () => {
  it('defaults category to business', () => {
    const parsed = partnerExpenseCreateSchema.parse({ amount: 42.5, itemLocation: 'Dinner — Vegas' });
    expect(parsed.category).toBe('business');
    expect(parsed.amount).toBe(42.5);
  });

  it('accepts personal category', () => {
    const parsed = partnerExpenseCreateSchema.parse({ amount: 10, itemLocation: 'Gift shop', category: 'personal' });
    expect(parsed.category).toBe('personal');
  });

  it('trims itemLocation and rejects empty', () => {
    expect(partnerExpenseCreateSchema.parse({ amount: 1, itemLocation: '  Uber  ' }).itemLocation).toBe('Uber');
    expect(() => partnerExpenseCreateSchema.parse({ amount: 1, itemLocation: '   ' })).toThrow();
  });

  it('rejects zero, negative, and non-numeric amounts', () => {
    expect(() => partnerExpenseCreateSchema.parse({ amount: 0, itemLocation: 'x' })).toThrow();
    expect(() => partnerExpenseCreateSchema.parse({ amount: -5, itemLocation: 'x' })).toThrow();
    expect(() => partnerExpenseCreateSchema.parse({ amount: 'abc', itemLocation: 'x' })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (in `apps/api`): `npm run test -- src/__tests__/partnerExpenses.test.ts`
Expected: FAIL — cannot resolve `../lib/partnerExpenses`.

- [ ] **Step 3: Implement**

New `apps/api/src/lib/partnerExpenses.ts`:

```ts
import { z } from 'zod';

export const partnerExpenseCreateSchema = z.object({
  amount: z.number().positive().finite(),
  itemLocation: z.string().transform((s) => s.trim()).pipe(z.string().min(1).max(300)),
  category: z.enum(['business', 'personal']).default('business'),
});

export type PartnerExpenseCreateInput = z.infer<typeof partnerExpenseCreateSchema>;
```

`apps/api/src/db/schema.ts` — add to the Enums section:

```ts
export const partnerExpenseCategoryEnum = pgEnum('partner_expense_category', ['business', 'personal']);
```

and add a new section after the Expenses tables (mirror surrounding style):

```ts
// ── Partner Expenses ──────────────────────────────────────────────────────────
// Standalone tracker for partner-related spend. Deliberately decoupled from the
// normal expense flow: no receipts, no review queue, no reimbursement, no Zoho.

export const partnerExpenses = pgTable('partner_expenses', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }).notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  itemLocation: text('item_location').notNull(),
  category: partnerExpenseCategoryEnum('category').default('business').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const partnerExpensesRelations = relations(partnerExpenses, ({ one }) => ({
  user: one(users, { fields: [partnerExpenses.userId], references: [users.id] }),
}));
```

(If the file groups all `relations()` calls together at the bottom, put `partnerExpensesRelations` there instead — follow the file's existing layout.)

- [ ] **Step 4: Run test to verify it passes**

Run (in `apps/api`): `npm run test -- src/__tests__/partnerExpenses.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Generate migration**

Run (in `apps/api`): `npm run db:generate`
Expected: new file `apps/api/drizzle/0009_*.sql` with `CREATE TYPE "public"."partner_expense_category"` and `CREATE TABLE "partner_expenses"`.

- [ ] **Step 6: Lint + commit**

Run (in `apps/api`): `npm run lint` — expect clean. Then:

```bash
git add apps/api/src/lib/partnerExpenses.ts apps/api/src/__tests__/partnerExpenses.test.ts \
  apps/api/src/db/schema.ts apps/api/drizzle
git commit -m "feat(api): add partner_expenses table and validation"
```

---

### Task 3: API router `/api/v1/partner-expenses`

**Files:**
- Create: `apps/api/src/routes/partnerExpenses.ts`
- Modify: `apps/api/src/server.ts` (import + mount alongside the other routers)

**Interfaces:**
- Consumes: `partnerExpenseCreateSchema` (Task 2), `partnerExpenses` + relations (Task 2), `requireRole('partner')` with developer bypass (Task 1).
- Produces: `GET /api/v1/partner-expenses` → `{ partnerExpenses: Array<{ id, userId, userName, amount, itemLocation, category, createdAt }> }` (all rows, newest first); `POST /api/v1/partner-expenses` body `{ amount, itemLocation, category? }` → `201 { partnerExpense }` (same row shape). This response shape is what the web api module (Task 4) types against.

- [ ] **Step 1: Implement the router**

New `apps/api/src/routes/partnerExpenses.ts` (mirrors `paymentMethods.ts` conventions):

```ts
import { Router } from 'express';
import { db } from '../db/index';
import { partnerExpenses } from '../db/schema';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { auditLog } from '../lib/audit';
import { partnerExpenseCreateSchema } from '../lib/partnerExpenses';

const router = Router();
router.use(authenticate);
// Shared partner view: every partner (and developer) sees all rows.
router.use(requireRole('partner'));

function toDto(row: { id: string; userId: string; amount: string; itemLocation: string; category: 'business' | 'personal'; createdAt: Date; user?: { name: string } | null }) {
  return {
    id: row.id,
    userId: row.userId,
    userName: row.user?.name ?? 'Unknown',
    amount: row.amount,
    itemLocation: row.itemLocation,
    category: row.category,
    createdAt: row.createdAt.toISOString(),
  };
}

router.get('/', asyncHandler(async (_req, res) => {
  const rows = await db.query.partnerExpenses.findMany({
    with: { user: { columns: { name: true } } },
    orderBy: (pe, { desc }) => [desc(pe.createdAt)],
  });
  res.json({ partnerExpenses: rows.map(toDto) });
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = partnerExpenseCreateSchema.parse(req.body);

  const [row] = await db.insert(partnerExpenses).values({
    userId: req.user!.id,
    amount: body.amount.toFixed(2),
    itemLocation: body.itemLocation,
    category: body.category,
  }).returning();

  await auditLog({
    entityType: 'partner_expense',
    entityId: row.id,
    userId: req.user!.id,
    action: 'created',
    after: row,
  });

  res.status(201).json({ partnerExpense: toDto({ ...row, user: { name: req.user!.name } }) });
}));

export default router;
```

- [ ] **Step 2: Mount it**

`apps/api/src/server.ts` — add with the other route imports (line ~24):

```ts
import partnerExpensesRouter from './routes/partnerExpenses';
```

and with the other mounts (after the `payment-methods` mount):

```ts
app.use('/api/v1/partner-expenses', partnerExpensesRouter);
```

- [ ] **Step 3: Verify**

Run (in `apps/api`): `npm run lint` — expect clean. Run `npm run test` — expect full suite PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/partnerExpenses.ts apps/api/src/server.ts
git commit -m "feat(api): partner-expenses routes (list + create, partner/developer only)"
```

---

### Task 4: Web plumbing — types, api module, developer bypass, nav, route

**Files:**
- Modify: `packages/shared/src/types/index.ts` (add `PartnerExpense` types)
- Modify: `apps/web/src/types/index.ts` (re-export them)
- Create: `apps/web/src/api/partnerExpenses.ts`
- Modify: `apps/web/src/components/ProtectedRoute.tsx:22`
- Modify: `apps/web/src/components/Sidebar.tsx:19-20` and nav list
- Modify: `apps/web/src/App.tsx` (route)

**Interfaces:**
- Consumes: API shapes from Task 3.
- Produces: `partnerExpenseApi.list(): Promise<PartnerExpense[]>` and `partnerExpenseApi.create(data: { amount: number; itemLocation: string; category: PartnerExpenseCategory }): Promise<PartnerExpense>`; route `/partner-expenses` rendering `PartnerExpenses` page (Task 5 creates the page — this task ends with a placeholder import that Task 5 fills; to keep every commit compiling, Task 4 and Task 5 are committed together, see Task 5 Step 4).

- [ ] **Step 1: Shared types**

`packages/shared/src/types/index.ts` — add after the Roles section:

```ts
// ── Partner Expenses ─────────────────────────────────────────────────────────

export type PartnerExpenseCategory = 'business' | 'personal';

export interface PartnerExpense {
  id: string;
  userId: string;
  userName: string;
  /** numeric comes back from the API as a string, e.g. "42.50" */
  amount: string;
  itemLocation: string;
  category: PartnerExpenseCategory;
  createdAt: string;
}
```

`apps/web/src/types/index.ts` — add `PartnerExpense, PartnerExpenseCategory,` to the re-export list.

- [ ] **Step 2: API module**

New `apps/web/src/api/partnerExpenses.ts`:

```ts
import client from './client';
import type { PartnerExpense, PartnerExpenseCategory } from '../types';

export const partnerExpenseApi = {
  list: () =>
    client.get<{ partnerExpenses: PartnerExpense[] }>('/partner-expenses')
      .then((r) => r.data.partnerExpenses),

  create: (data: { amount: number; itemLocation: string; category: PartnerExpenseCategory }) =>
    client.post<{ partnerExpense: PartnerExpense }>('/partner-expenses', data)
      .then((r) => r.data.partnerExpense),
};
```

- [ ] **Step 3: Developer bypass in ProtectedRoute**

`apps/web/src/components/ProtectedRoute.tsx` line 22 becomes:

```ts
  if (roles && user.role !== 'developer' && !roles.includes(user.role)) return <Navigate to="/dashboard" replace />;
```

- [ ] **Step 4: Sidebar**

`apps/web/src/components/Sidebar.tsx` — replace lines 19-20:

```ts
  const isDeveloper = user?.role === 'developer';
  const isPrivileged = user?.role === 'accountant' || user?.role === 'admin' || isDeveloper;
  const isAdmin = user?.role === 'admin' || isDeveloper;
  const isPartner = user?.role === 'partner' || isDeveloper;
```

Add `Briefcase` to the lucide-react import, and insert a Partner section between the main nav block and the `isPrivileged` block:

```tsx
        {isPartner && (
          <>
            <div className="my-2 border-t border-gray-100" />
            <p className="px-3 py-1 text-xs font-semibold uppercase tracking-wider text-gray-400">Partner</p>
            <NavLink to="/partner-expenses" className={linkClass}>
              <Briefcase className="h-4 w-4" />
              Partner Expenses
            </NavLink>
          </>
        )}
```

- [ ] **Step 5: Route**

`apps/web/src/App.tsx` — import `{ PartnerExpenses } from './pages/PartnerExpenses';` and add inside the Layout route group (after `/to-upload`):

```tsx
              <Route
                path="/partner-expenses"
                element={
                  <ProtectedRoute roles={['partner', 'developer']}>
                    <PartnerExpenses />
                  </ProtectedRoute>
                }
              />
```

(This won't compile until Task 5 creates the page — proceed straight to Task 5; the combined commit happens there.)

---

### Task 5: PartnerExpenses page

**Files:**
- Create: `apps/web/src/pages/PartnerExpenses.tsx`

**Interfaces:**
- Consumes: `partnerExpenseApi` (Task 4), `PartnerExpense` / `PartnerExpenseCategory` types (Task 4).

- [ ] **Step 1: Implement the page**

New `apps/web/src/pages/PartnerExpenses.tsx` — mirrors My Expenses styling (`ExpenseList.tsx`): white rounded-xl card, same table header/row classes, brand-600 primary button. Category renders as a badge (business = brand/blue tint, personal = gray). Intake is an inline card toggled by the "New Partner Expense" button; category is a Business/Personal segmented toggle defaulting to Business.

```tsx
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { partnerExpenseApi } from '../api/partnerExpenses';
import type { PartnerExpenseCategory } from '../types';

function CategoryBadge({ category }: { category: PartnerExpenseCategory }) {
  return category === 'business' ? (
    <span className="inline-block rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700">Business</span>
  ) : (
    <span className="inline-block rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600">Personal</span>
  );
}

export function PartnerExpenses() {
  const qc = useQueryClient();
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['partner-expenses'],
    queryFn: () => partnerExpenseApi.list(),
  });

  const [formOpen, setFormOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [itemLocation, setItemLocation] = useState('');
  const [category, setCategory] = useState<PartnerExpenseCategory>('business');
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () =>
      partnerExpenseApi.create({ amount: Number(amount), itemLocation: itemLocation.trim(), category }),
    onSuccess: () => {
      setAmount('');
      setItemLocation('');
      setCategory('business');
      setFormOpen(false);
      setError(null);
      void qc.invalidateQueries({ queryKey: ['partner-expenses'] });
    },
    onError: () => setError('Could not save the expense. Check the fields and try again.'),
  });

  const total = useMemo(() => rows.reduce((sum, r) => sum + Number(r.amount || 0), 0), [rows]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('Enter an amount greater than 0.');
      return;
    }
    if (!itemLocation.trim()) {
      setError('Enter an item or location.');
      return;
    }
    setError(null);
    createMutation.mutate();
  }

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-gray-900">Partner Expenses</h1>
        <button
          type="button"
          onClick={() => setFormOpen((o) => !o)}
          className="flex shrink-0 items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          <Plus className="h-4 w-4" />
          New Partner Expense
        </button>
      </div>

      {!isLoading && rows.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
            <p className="text-xs font-medium text-gray-500">Total logged</p>
            <p className="mt-0.5 text-xl font-bold text-gray-900">
              ${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
            <p className="text-xs font-medium text-gray-500">Entries</p>
            <p className="mt-0.5 text-xl font-bold text-gray-900">{rows.length}</p>
          </div>
        </div>
      )}

      {formOpen && (
        <form onSubmit={submit} className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="w-full sm:w-40">
              <label className="mb-1 block text-xs font-medium text-gray-500">Amount</label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                required
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-gray-500">Item / Location</label>
              <input
                type="text"
                value={itemLocation}
                onChange={(e) => setItemLocation(e.target.value)}
                placeholder="e.g. Dinner — Las Vegas"
                required
                maxLength={300}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Category</label>
              <div className="flex rounded-lg border border-gray-200 bg-gray-100 p-1">
                {(['business', 'personal'] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategory(c)}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
                      category === c ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {createMutation.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </form>
      )}

      <div className="rounded-xl border border-gray-200 bg-white">
        {isLoading ? (
          <div className="px-6 py-12 text-center text-sm text-gray-400">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-gray-500">
            No partner expenses yet. Log the first one with “New Partner Expense”.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                <th className="px-6 py-3">User</th>
                <th className="px-6 py-3 text-right">Amount</th>
                <th className="px-6 py-3">Item / Location</th>
                <th className="px-6 py-3">Category</th>
                <th className="px-6 py-3">Logged</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 font-medium text-gray-900">{r.userName}</td>
                  <td className="px-6 py-4 text-right font-medium text-gray-900">${Number(r.amount).toFixed(2)}</td>
                  <td className="px-6 py-4 text-gray-600">{r.itemLocation}</td>
                  <td className="px-6 py-4"><CategoryBadge category={r.category} /></td>
                  <td className="px-6 py-4 text-gray-600">{new Date(r.createdAt).toLocaleDateString()}</td>
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

- [ ] **Step 2: Verify web build**

Run (in `packages/shared`): `npm run build` (so the web tsc sees the new shared types).
Run (in `apps/web`): `npm run lint`
Expected: clean.

- [ ] **Step 3: Verify API still clean**

Run (in `apps/api`): `npm run lint && npm run test`
Expected: clean, full suite PASS.

- [ ] **Step 4: Commit (Tasks 4 + 5 together — first compiling web state)**

```bash
git add packages/shared/src/types/index.ts apps/web/src/types/index.ts \
  apps/web/src/api/partnerExpenses.ts apps/web/src/components/ProtectedRoute.tsx \
  apps/web/src/components/Sidebar.tsx apps/web/src/App.tsx apps/web/src/pages/PartnerExpenses.tsx
git commit -m "feat(web): partner expenses page, nav, and developer role bypass"
```

---

### Task 6: Final verification

- [ ] **Step 1: Full workspace check**

Run (repo root): `npm run lint` — all workspaces clean.
Run (in `apps/api`): `npm run test` — full suite PASS.

- [ ] **Step 2: Report**

Summarize for the user: what shipped, seed credentials for the two new roles, the two new migration files (applied automatically by `db:push --force` in Docker dev, or `npm run db:migrate` in production), and the dirty-tree caveat (which commits carried pre-existing WIP hunks in `schema.ts` / shared types).
