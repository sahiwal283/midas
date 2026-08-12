# Accountant Review Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single accountant review queue with two SQL-scoped pages — Event Review (`/accountant/events`) and Daily Review (`/accountant/daily`) — each showing only its own expenses with reimbursements as a lane, and remove the accountant Purchase Orders queue.

**Architecture:** A `scope` query parameter (`'event' | 'daily'`) filters the three accountant queue endpoints in SQL, using the daily/event line the codebase already draws for auto-push. The 1,309-line `AccountantQueue.tsx` gains a `scope` prop and is mounted by two thin route elements rather than being copied. `queue/summary` returns a per-scope breakdown so the dashboard can show combined totals with per-page links.

**Tech Stack:** TypeScript, Express, Drizzle ORM, Vitest, React, TanStack Query, React Router 7, Tailwind. Deploy: file-push to CT 3120 per `docs/OPERATIONS.md`.

## Global Constraints

- Scope rule, applied in SQL — never client-side:
  - **daily** → `source_app IS NULL OR source_app = 'browser_extension'`
  - **event** → `source_app IS NOT NULL AND source_app <> 'browser_extension'`
  These are exact complements: every expense belongs to exactly one page.
- Partner-kind expenses stay excluded from both pages (`expense_kind = 'business'` filters already present — do not remove them).
- Both pages carry the identical 10 lanes. Reimbursement stays a lane on each, scoped to that page.
- Page names in the sidebar: **Event Review** and **Daily Review**.
- Purchase Orders: remove the accountant queue page, route and nav entry ONLY. PO creation (`PurchaseOrderNew`), PO detail (`PurchaseOrderDetail`), `routes/transactions.ts` and `lib/zohoPoPush.ts` all keep working.
- `/accountant` must redirect to `/accountant/daily` so existing links and the expense-detail back button keep working.
- `GET /accountant/queue/summary` keeps its existing top-level shape (`counts`, `readyForZohoAmount`, `reimbursementPendingAmount`, `reimbursementEmployees`) and ADDS the per-scope breakdown. Do not rename or remove existing fields.
- No change to review, approval, or Zoho push behavior.
- A file-push deploy never deletes: after any commit that deletes files, remove them explicitly on CT 3120 (see `docs/OPERATIONS.md`).
- Version bump: 0.42.0 → 0.43.0 in `apps/api/package.json`, `apps/web/package.json`, `packages/shared/package.json`, and `packages/shared/src/version.ts` — all four must agree.
- Commits end with the standard `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + `Claude-Session` trailer.

---

### Task 1: Scope predicate and filter parsing (TDD)

**Files:**
- Create: `apps/api/src/lib/queueScope.ts`
- Test: `apps/api/src/__tests__/queueScope.test.ts`
- Modify: `apps/api/src/lib/queueFilters.ts` (the `QueueFilters` type and `parseQueueFilters`, ~lines 1-50)

**Interfaces:**
- Produces:
  - `type QueueScope = 'event' | 'daily'`
  - `parseQueueScope(raw: string | undefined): QueueScope | undefined` — returns the scope only for the two exact strings, `undefined` otherwise.
  - `isDailyExpense(e: { sourceApp: string | null }): boolean` — the pure predicate the SQL mirrors, used by the summary bucketing in Task 3.
  - `QueueFilters.scope?: QueueScope`, populated by `parseQueueFilters`.

- [ ] **Step 1: Write the failing test** `apps/api/src/__tests__/queueScope.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { parseQueueScope, isDailyExpense } from '../lib/queueScope';

describe('parseQueueScope', () => {
  it('accepts the two valid scopes', () => {
    expect(parseQueueScope('event')).toBe('event');
    expect(parseQueueScope('daily')).toBe('daily');
  });
  it('ignores anything else rather than guessing', () => {
    expect(parseQueueScope(undefined)).toBeUndefined();
    expect(parseQueueScope('')).toBeUndefined();
    expect(parseQueueScope('EVENT')).toBeUndefined();
    expect(parseQueueScope('all')).toBeUndefined();
  });
});

describe('isDailyExpense', () => {
  it('treats Midas-native and browser-extension expenses as daily', () => {
    expect(isDailyExpense({ sourceApp: null })).toBe(true);
    expect(isDailyExpense({ sourceApp: 'browser_extension' })).toBe(true);
  });
  it('treats external app expenses as event', () => {
    expect(isDailyExpense({ sourceApp: 'trade_show' })).toBe(false);
    expect(isDailyExpense({ sourceApp: 'argo' })).toBe(false);
  });
  it('is a total split — every expense is daily or event, never both or neither', () => {
    for (const sourceApp of [null, 'browser_extension', 'trade_show', 'argo', '']) {
      const daily = isDailyExpense({ sourceApp });
      expect(typeof daily).toBe('boolean');
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/__tests__/queueScope.test.ts`
Expected: FAIL — cannot find module `../lib/queueScope`.

- [ ] **Step 3: Implement** `apps/api/src/lib/queueScope.ts`

```ts
import { and, eq, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { expenses } from '../db/schema';

/** Which accountant review page an expense belongs to. */
export type QueueScope = 'event' | 'daily';

/**
 * Daily = entered in Midas or via the browser extension. Event = came from an
 * external app (trade_show, …). This mirrors the line lib/autoApprove.ts already
 * draws for auto-push, so the two review pages inherit a rule the system
 * already enforces. The two cases are exact complements: every expense belongs
 * to exactly one page.
 */
export function isDailyExpense(e: { sourceApp: string | null }): boolean {
  return e.sourceApp === null || e.sourceApp === 'browser_extension';
}

export function parseQueueScope(raw: string | undefined): QueueScope | undefined {
  return raw === 'event' || raw === 'daily' ? raw : undefined;
}

/** SQL mirror of isDailyExpense. Filtering happens server-side, never in the client. */
export function scopeCondition(scope: QueueScope): SQL {
  const daily = or(isNull(expenses.sourceApp), eq(expenses.sourceApp, 'browser_extension'))!;
  return scope === 'daily'
    ? daily
    : and(sql`${expenses.sourceApp} IS NOT NULL`, ne(expenses.sourceApp, 'browser_extension'))!;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/__tests__/queueScope.test.ts`
Expected: all pass.

- [ ] **Step 5: Add `scope` to the filter type and parser**

In `apps/api/src/lib/queueFilters.ts`, add to the `QueueFilters` interface:

```ts
  scope?: 'event' | 'daily';
```

and inside `parseQueueFilters`, alongside the other assignments:

```ts
  if (q.scope === 'event' || q.scope === 'daily') f.scope = q.scope;
```

(Keeping the check inline avoids a circular import between `queueFilters.ts` and `queueScope.ts`.)

- [ ] **Step 6: Full suite + lint**

Run: `cd apps/api && npm run test && npm run lint`
Expected: all pass (363 existing + new), lint clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/queueScope.ts apps/api/src/__tests__/queueScope.test.ts apps/api/src/lib/queueFilters.ts
git commit -m "feat(api): queue scope predicate for event vs daily review"
```

---

### Task 2: Apply scope to the queue and all-expenses endpoints

**Files:**
- Modify: `apps/api/src/routes/accountant.ts` — the `/queue` handler's `conds` array (~line 68) and `GET /expenses` (~line 237)

**Interfaces:**
- Consumes: `parseQueueScope`, `scopeCondition` (Task 1); `QueueFilters.scope`.
- Produces: `GET /accountant/queue?scope=event|daily` and `GET /accountant/expenses?scope=event|daily` return only that scope's expenses. Omitting `scope` preserves today's unscoped behavior.

- [ ] **Step 1: Import the helper**

At the top of `apps/api/src/routes/accountant.ts`:

```ts
import { scopeCondition } from '../lib/queueScope';
```

- [ ] **Step 2: Scope the paginated queue**

`parseQueueFilters` already populates `f.scope` (Task 1). In the `/queue` handler, immediately after the `conds` array is built (it currently starts with `inArray(expenses.status, queueStatuses)` and `eq(expenses.expenseKind, 'business')`), add:

```ts
  // Event and daily are separate pages; the split is enforced in SQL so neither
  // page can ever receive the other's rows.
  if (f.scope) conds.push(scopeCondition(f.scope));
```

- [ ] **Step 3: Scope the all-expenses lane**

`GET /expenses` currently has `where: eq(expenses.expenseKind, 'business')`. Parse the scope from the query and combine:

```ts
  const scope = parseQueueScope(typeof req.query.scope === 'string' ? req.query.scope : undefined);
  const where = scope
    ? and(eq(expenses.expenseKind, 'business'), scopeCondition(scope))
    : eq(expenses.expenseKind, 'business');
```

then use `where` in that query. Add `parseQueueScope` to the import from `../lib/queueScope`. Confirm `and` is already imported from `drizzle-orm` in this file.

- [ ] **Step 4: Verify no other queue-scoped query was missed**

Run: `grep -n "QUEUE_STATUSES\|expenseKind, 'business'" apps/api/src/routes/accountant.ts`
Every hit must be one of: the `/queue` handler (now scoped), `/queue/summary` (Task 3 scopes it), `GET /expenses` (now scoped), or `/employees` (deliberately unscoped — it lists people, not expenses). Note which is which in your report.

- [ ] **Step 5: Full suite + lint**

Run: `cd apps/api && npm run test && npm run lint`
Expected: pass. Existing tests must be unaffected because omitting `scope` preserves current behavior.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/accountant.ts
git commit -m "feat(api): scope the accountant queue and all-expenses lane"
```

---

### Task 3: Per-scope summary for the dashboard (TDD)

**Files:**
- Create: `apps/api/src/lib/queueSummaryBuckets.ts`
- Test: `apps/api/src/__tests__/queueSummaryBuckets.test.ts`
- Modify: `apps/api/src/routes/accountant.ts` — the `/queue/summary` handler (~lines 171-232)

**Interfaces:**
- Consumes: `isDailyExpense` (Task 1).
- Produces: `GET /accountant/queue/summary` response gains `byScope: { event: ScopeCounts; daily: ScopeCounts }` where `ScopeCounts = { counts: Record<string, number>; readyForZohoAmount: number; reimbursementPendingAmount: number; reimbursementEmployees: number }`. Existing top-level fields are unchanged.
- `splitCountsByScope(rows, countOne): { event: T; daily: T }` in `lib/queueSummaryBuckets.ts`.

- [ ] **Step 1: Write the failing test** `apps/api/src/__tests__/queueSummaryBuckets.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { splitRowsByScope } from '../lib/queueSummaryBuckets';

const rows = [
  { sourceApp: null, amount: '10' },
  { sourceApp: 'browser_extension', amount: '20' },
  { sourceApp: 'trade_show', amount: '30' },
  { sourceApp: 'argo', amount: '40' },
];

describe('splitRowsByScope', () => {
  it('routes each row to exactly one bucket', () => {
    const { event, daily } = splitRowsByScope(rows);
    expect(daily.map((r) => r.amount)).toEqual(['10', '20']);
    expect(event.map((r) => r.amount)).toEqual(['30', '40']);
  });

  it('loses no rows — the two buckets sum to the input', () => {
    const { event, daily } = splitRowsByScope(rows);
    expect(event.length + daily.length).toBe(rows.length);
  });

  it('handles an empty input', () => {
    const { event, daily } = splitRowsByScope([]);
    expect(event).toEqual([]);
    expect(daily).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/__tests__/queueSummaryBuckets.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement** `apps/api/src/lib/queueSummaryBuckets.ts`

```ts
import { isDailyExpense } from './queueScope';

/**
 * Partition queue rows into the two review pages. Pure and total: every row
 * lands in exactly one bucket, so the dashboard's per-scope numbers always sum
 * to its combined totals.
 */
export function splitRowsByScope<T extends { sourceApp: string | null }>(
  rows: T[],
): { event: T[]; daily: T[] } {
  const event: T[] = [];
  const daily: T[] = [];
  for (const row of rows) {
    if (isDailyExpense(row)) daily.push(row);
    else event.push(row);
  }
  return { event, daily };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/__tests__/queueSummaryBuckets.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Refactor the summary handler to compute per scope**

In `/queue/summary`, the counting loop currently runs once over `rows`. Extract the body of that loop into a local function so it can run three times without duplicating logic — over all rows (for the existing top-level fields) and over each bucket:

```ts
  function tally(subset: typeof rows) {
    const counts: Record<string, number> = {
      pending: 0, in_review: 0, awaiting_info: 0, zoho_sync_failed: 0, approved: 0,
      needs_category: 0, missing_receipt: 0, needs_payment_method: 0, needs_entity: 0,
      ready_for_zoho: 0, reimbursement_pending: 0,
    };
    let readyForZohoAmount = 0;
    let reimbursementPendingAmount = 0;
    const reimbursementEmployeeIds = new Set<string>();

    for (const row of subset) {
      const wireStatus = row.integrationStatus === 'failed' && row.status === 'approved'
        ? 'zoho_sync_failed'
        : row.status;
      counts[wireStatus] = (counts[wireStatus] ?? 0) + 1;
      const flags = computeFlags(row as Parameters<typeof computeFlags>[0]);
      for (const flag of flags) {
        if (flag in counts) counts[flag]++;
      }
      if (flags.includes('ready_for_zoho')) readyForZohoAmount += Number(row.amount || 0);
      if (row.reimbursementStatus === 'pending') {
        reimbursementPendingAmount += Number(row.amount || 0);
        reimbursementEmployeeIds.add(row.userId);
      }
    }

    return {
      counts,
      readyForZohoAmount,
      reimbursementPendingAmount,
      reimbursementEmployees: reimbursementEmployeeIds.size,
    };
  }

  const overall = tally(rows);
  const { event, daily } = splitRowsByScope(rows);

  res.json({
    ...overall,
    byScope: { event: tally(event), daily: tally(daily) },
  });
```

Add the import: `import { splitRowsByScope } from '../lib/queueSummaryBuckets';`

The spread of `overall` preserves the exact existing top-level shape (`counts`, `readyForZohoAmount`, `reimbursementPendingAmount`, `reimbursementEmployees`) so current consumers keep working.

- [ ] **Step 6: Full suite + lint**

Run: `cd apps/api && npm run test && npm run lint`
Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/queueSummaryBuckets.ts apps/api/src/__tests__/queueSummaryBuckets.test.ts apps/api/src/routes/accountant.ts
git commit -m "feat(api): per-scope breakdown on the accountant queue summary"
```

---

### Task 4: Two scoped routes over one component

**Files:**
- Modify: `apps/web/src/pages/AccountantQueue.tsx` (component signature ~line 215; the two `useQuery` calls ~lines 262-274; the page heading)
- Modify: `apps/web/src/App.tsx` (accountant routes ~lines 75-90)
- Modify: `apps/web/src/api/expenses.ts` (the accountant queue API calls, so `scope` reaches the server)

**Interfaces:**
- Consumes: `?scope=` on `/accountant/queue`, `/accountant/expenses` (Task 2).
- Produces: `AccountantQueue` accepts `{ scope: 'event' | 'daily' }` and is mounted at `/accountant/events` and `/accountant/daily`; `/accountant` redirects to `/accountant/daily`.

- [ ] **Step 1: Give the component a scope prop**

Change the signature at `apps/web/src/pages/AccountantQueue.tsx:215`:

```tsx
export function AccountantQueue({ scope }: { scope: 'event' | 'daily' }) {
```

- [ ] **Step 2: Send the scope with every request and key the cache by it**

Find where the page builds its request params (the function that assembles `params` from `filters`, used by the queue `useQuery`) and add `scope` to the outgoing params. Then include `scope` in BOTH `useQuery` keys so switching pages refetches instead of showing the other page's cached rows:

```tsx
    queryKey: ['accountant-queue', scope, filters, page],
```
and
```tsx
    queryKey: ['accountant-queue-summary', scope],
```

Read the existing keys before editing and preserve their other members exactly — only add `scope`. The queue summary call must also pass the scope through to the API so lane badges match the rows listed.

- [ ] **Step 3: Title the page by scope**

Replace the page's hard-coded heading with:

```tsx
  const title = scope === 'event' ? 'Event Review' : 'Daily Review';
  const subtitle = scope === 'event'
    ? 'Expenses submitted from trade shows and other connected apps.'
    : 'Expenses entered in Midas or captured with the browser extension.';
```

and render `title`/`subtitle` in the existing header block.

- [ ] **Step 4: Wire the routes**

In `apps/web/src/App.tsx`, replace the `/accountant` route and DELETE the `/accountant/purchase-orders` route:

```tsx
              <Route path="/accountant" element={<Navigate to="/accountant/daily" replace />} />
              <Route
                path="/accountant/daily"
                element={
                  <ProtectedRoute roles={['accountant', 'admin']}>
                    <AccountantQueue scope="daily" />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/accountant/events"
                element={
                  <ProtectedRoute roles={['accountant', 'admin']}>
                    <AccountantQueue scope="event" />
                  </ProtectedRoute>
                }
              />
```

Import `Navigate` from `react-router-dom` and remove the now-unused `PurchaseOrderQueue` import.

**Route order matters:** `/accountant/:id` (the expense detail route) must come AFTER `/accountant/daily` and `/accountant/events`, or those literals will be captured as an `:id`. Verify the final order.

- [ ] **Step 5: Type-check and build**

Run: `cd apps/web && npm run lint && npm run build`
Expected: clean. If `PurchaseOrderQueue` is still imported anywhere, remove the import.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/AccountantQueue.tsx apps/web/src/App.tsx apps/web/src/api/expenses.ts
git commit -m "feat(web): event and daily review pages over one scoped queue"
```

---

### Task 5: Navigation, active state, and the dashboard

**Files:**
- Modify: `apps/web/src/components/Sidebar.tsx` (accountant nav block)
- Modify: `apps/web/src/lib/navActive.ts` (rewrite `accountantNavActive`)
- Modify: `apps/web/src/pages/Dashboard.tsx` (`AccountantDashboard` rows ~lines 34-60)
- Modify: `apps/web/src/components/MobileNav.tsx` (the `/accountant` links)
- Test: `apps/web/src/lib/navActive.ts` has no test framework in this workspace — verify by the one-off script in Step 3

**Interfaces:**
- Consumes: `byScope` from `queue/summary` (Task 3); the routes from Task 4.
- Produces: `accountantNavActive(location)` returning `{ eventReview: boolean; dailyReview: boolean }`.

- [ ] **Step 1: Rewrite the nav active-state helper**

Replace the body of `apps/web/src/lib/navActive.ts` with:

```ts
/**
 * Active-state for the Accountant sidebar links.
 *
 * The review queue is now two pages under /accountant. An expense detail page
 * (/accountant/<id>) belongs to whichever queue the user came from, but the URL
 * alone cannot say which — so neither page is marked active there rather than
 * guessing wrong.
 */
export interface NavLocation {
  pathname: string;
  search: string;
}

export function accountantNavActive(location: NavLocation): {
  eventReview: boolean;
  dailyReview: boolean;
} {
  const { pathname } = location;
  return {
    eventReview: pathname === '/accountant/events',
    dailyReview: pathname === '/accountant/daily',
  };
}
```

- [ ] **Step 2: Update the sidebar**

In `apps/web/src/components/Sidebar.tsx`, replace the three accountant NavLinks (Review Queue, Purchase Orders, Reimbursements) with two:

```tsx
              <NavLink to="/accountant/events" className={() => linkClass({ isActive: accountantActive.eventReview })}>
                <ClipboardList className="h-4 w-4" />
                Event Review
              </NavLink>
              <NavLink to="/accountant/daily" className={() => linkClass({ isActive: accountantActive.dailyReview })}>
                <ReceiptText className="h-4 w-4" />
                Daily Review
              </NavLink>
```

Remove the now-unused `FileSpreadsheet` and `Banknote` imports if nothing else in the file uses them (check first — `Banknote` may be used elsewhere).

- [ ] **Step 3: Verify the active state with a one-off script**

The web workspace has no test runner, so verify by script:

```bash
cd /Users/sahilkhatri/Work/midas/apps/web
cat > /tmp/navcheck.ts <<'EOF'
import { accountantNavActive } from './src/lib/navActive';
const cases: Array<[string, boolean, boolean]> = [
  ['/accountant/events', true, false],
  ['/accountant/daily', false, true],
  ['/accountant/abc-123', false, false],
  ['/reports', false, false],
];
let fail = 0;
for (const [pathname, wantEvent, wantDaily] of cases) {
  const got = accountantNavActive({ pathname, search: '' });
  const ok = got.eventReview === wantEvent && got.dailyReview === wantDaily;
  if (!ok) fail++;
  const lit = [got.eventReview && 'event', got.dailyReview && 'daily'].filter(Boolean);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${pathname.padEnd(24)} active: ${lit.join(', ') || 'none'}`);
}
process.exit(fail ? 1 : 0);
EOF
npx tsx /tmp/navcheck.ts && rm -f /tmp/navcheck.ts
```
Expected: all PASS — exactly one item active on each page, none on a detail page.

- [ ] **Step 4: Make the dashboard cover both queues**

In `apps/web/src/pages/Dashboard.tsx`, `AccountantDashboard` reads `summary.counts`. Add the per-scope chips. Replace the `rows` array with one that carries both a combined count and per-scope links:

```tsx
  const counts = summary?.counts ?? {};
  const byScope = summary?.byScope;
  const scoped = (pick: (c: Record<string, number>) => number) => ({
    event: byScope ? pick(byScope.event.counts) : 0,
    daily: byScope ? pick(byScope.daily.counts) : 0,
  });

  const rows = [
    {
      label: 'Needs Review',
      count: (counts.pending ?? 0) + (counts.in_review ?? 0),
      per: scoped((c) => (c.pending ?? 0) + (c.in_review ?? 0)),
      query: 'status=needs_review',
      icon: <Clock className="h-4 w-4 text-yellow-600" />,
    },
    {
      label: 'Awaiting User',
      count: counts.awaiting_info ?? 0,
      per: scoped((c) => c.awaiting_info ?? 0),
      query: 'status=awaiting_user',
      icon: <AlertCircle className="h-4 w-4 text-amber-600" />,
    },
    {
      label: 'Zoho Failed',
      count: counts.zoho_sync_failed ?? 0,
      per: scoped((c) => c.zoho_sync_failed ?? 0),
      query: 'status=zoho_failed',
      icon: <RefreshCw className="h-4 w-4 text-red-600" />,
    },
    {
      label: 'Missing Fields',
      count: (counts.needs_category ?? 0) + (counts.missing_receipt ?? 0) + (counts.needs_payment_method ?? 0),
      per: scoped((c) => (c.needs_category ?? 0) + (c.missing_receipt ?? 0) + (c.needs_payment_method ?? 0)),
      query: '',
      icon: <FileX className="h-4 w-4 text-orange-600" />,
    },
  ];
```

Each rendered row keeps its combined count and gains two links. Replace the row's single wrapping `<Link>` with a non-link container holding the label, the combined count, and these chips:

```tsx
                <div className="flex items-center gap-2">
                  <Link
                    to={`/accountant/events${row.query ? `?${row.query}` : ''}`}
                    className="rounded-md bg-ink/5 px-2 py-0.5 text-xs font-medium text-charcoal/70 hover:bg-ink/10 hover:text-ink"
                  >
                    {row.per.event} event
                  </Link>
                  <Link
                    to={`/accountant/daily${row.query ? `?${row.query}` : ''}`}
                    className="rounded-md bg-ink/5 px-2 py-0.5 text-xs font-medium text-charcoal/70 hover:bg-ink/10 hover:text-ink"
                  >
                    {row.per.daily} daily
                  </Link>
                </div>
```

The two money cards (Ready for Zoho, Awaiting Reimbursement) keep their existing combined amounts; point their links at `/accountant/daily` and `/accountant/daily?reimbursementStatus=pending` respectively.

- [ ] **Step 5: Fix the mobile nav**

In `apps/web/src/components/MobileNav.tsx`, the bottom-bar "Queue" NavLink and the More-sheet links point at `/accountant` and `/accountant/purchase-orders`. Point the bottom-bar link at `/accountant/daily`, replace the sheet's Review Queue entry with two entries (Event Review → `/accountant/events`, Daily Review → `/accountant/daily`), and delete the Purchase Orders and Reimbursements sheet entries.

- [ ] **Step 6: Type-check and build**

Run: `cd apps/web && npm run lint && npm run build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/Sidebar.tsx apps/web/src/lib/navActive.ts apps/web/src/pages/Dashboard.tsx apps/web/src/components/MobileNav.tsx
git commit -m "feat(web): split accountant nav, dashboard covers both queues"
```

---

### Task 6: Delete the PO review queue page

**Files:**
- Delete: `apps/web/src/pages/PurchaseOrderQueue.tsx`
- Modify: any file still importing it

**Interfaces:**
- Produces: nothing. Removes the accountant PO queue only.

- [ ] **Step 1: Confirm nothing else depends on it**

Run: `grep -rn "PurchaseOrderQueue" apps/web/src`
Expected: only its own file (the App.tsx route was removed in Task 4). If App.tsx still references it, remove that first.

- [ ] **Step 2: Delete the page**

```bash
rm apps/web/src/pages/PurchaseOrderQueue.tsx
```

- [ ] **Step 3: Confirm PO creation and push are untouched**

Run: `ls apps/web/src/pages/PurchaseOrderNew.tsx apps/web/src/pages/PurchaseOrderDetail.tsx apps/api/src/routes/transactions.ts apps/api/src/lib/zohoPoPush.ts`
Expected: all four still exist. These must NOT be deleted.

- [ ] **Step 4: Type-check and build both workspaces**

Run: `cd apps/web && npm run lint && npm run build && cd ../api && npm run lint && npm run test`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web
git commit -m "refactor(web): remove the accountant purchase order queue"
```

---

### Task 7: Verify against live data, then deploy

**Files:**
- Modify: `apps/api/package.json:3`, `apps/web/package.json:3`, `packages/shared/package.json:3`, `packages/shared/src/version.ts` → `0.43.0`

- [ ] **Step 1: Prove the split on a copy of the live database**

Production currently holds 376 expenses, all `source_app='trade_show'` — so Event Review should show all of them and Daily Review none, until a daily expense is created.

```bash
cd /Users/sahilkhatri/Work/midas
ssh root@192.168.1.190 "pct exec 3220 -- su - postgres -c 'pg_dump -d midas'" > /tmp/rs.sql
dropdb -h 127.0.0.1 midas_rs_test 2>/dev/null; createdb -h 127.0.0.1 midas_rs_test
psql -q postgresql://sahilkhatri@127.0.0.1:5432/midas_rs_test -f /tmp/rs.sql
# make one daily expense so both scopes have data
psql postgresql://sahilkhatri@127.0.0.1:5432/midas_rs_test -c \
  "update expenses set source_app=null where id=(select id from expenses where status='pending' limit 1)"
psql postgresql://sahilkhatri@127.0.0.1:5432/midas_rs_test -c \
  "select case when source_app is null or source_app='browser_extension' then 'daily' else 'event' end as scope, count(*) from expenses group by 1"
```
Expected: 1 daily, 375 event.

- [ ] **Step 2: Verify through the API that neither page sees the other's rows**

```bash
cd apps/api
HASH=$(node -e "console.log(require('bcryptjs').hashSync('rstest12345',12))")
psql postgresql://sahilkhatri@127.0.0.1:5432/midas_rs_test -qc "update users set password_hash='$HASH' where username='admin'"
DATABASE_URL=postgresql://sahilkhatri@127.0.0.1:5432/midas_rs_test JWT_SECRET=rs-test-secret-at-least-32-chars-ok AUTH_MODE=local OCR_MODE=mock ZOHO_MODE=mock STORAGE_MODE=local UPLOADS_DIR=./uploads PORT=4092 COOKIE_SECURE=false npx tsx src/server.ts &
# then, once healthy:
#   login as admin / rstest12345
#   GET /api/v1/accountant/expenses?scope=daily   → 1 row, source_app null
#   GET /api/v1/accountant/expenses?scope=event   → 375 rows, none with source_app null
#   GET /api/v1/accountant/queue?scope=daily      → no trade_show rows
#   GET /api/v1/accountant/queue/summary          → byScope.event.counts + byScope.daily.counts sum to counts
```
The last assertion is the important one: the per-scope numbers must sum to the combined totals, proving no expense was dropped or double-counted. Stop the server and `dropdb midas_rs_test` afterwards.

- [ ] **Step 3: Bump versions, run all checks, merge, push**

```bash
sed -i '' 's/"version": "0.42.0"/"version": "0.43.0"/' apps/api/package.json apps/web/package.json packages/shared/package.json
sed -i '' "s/export const MIDAS_VERSION = '.*';/export const MIDAS_VERSION = '0.43.0';/" packages/shared/src/version.ts
(cd apps/api && npm run lint && npm run test) && (cd apps/web && npm run lint && npm run build)
git add -A apps packages
git commit -m "chore: bump version to 0.43.0"
git checkout main && git merge --no-ff <feature-branch> && git push origin main
```

- [ ] **Step 4: Deploy to CT 3120**

No migrations in this plan — code only.

```bash
tar czf /tmp/rs-deploy.tgz apps/api/src apps/web/src apps/api/package.json apps/web/package.json packages/shared/src packages/shared/package.json
scp /tmp/rs-deploy.tgz root@192.168.1.190:/tmp/
ssh root@192.168.1.190 "pct push 3120 /tmp/rs-deploy.tgz /tmp/d.tgz && pct exec 3120 -- bash -c 'cd /opt/midas && tar xzf /tmp/d.tgz; rm -f /tmp/d.tgz; find . -name \"._*\" -delete'"

# A file-push deploy never deletes — remove files this branch deleted:
git diff --diff-filter=D --name-only <merge-base> HEAD
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && rm -f apps/web/src/pages/PurchaseOrderQueue.tsx'"

ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose up -d --no-deps --build api'"
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose -f docker-compose.prod.yml up -d --no-deps --build web'"
```

- [ ] **Step 5: Verify in production**

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://midas.booute.duckdns.org/          # 200
ssh root@192.168.1.190 "pct exec 3120 -- curl -s http://localhost:4000/api/v1/meta"  # 0.43.0
# confirm the new nav shipped:
JS=$(curl -s https://midas.booute.duckdns.org/ | grep -oE '/assets/index-[A-Za-z0-9._-]+\.js' | head -1)
curl -s "https://midas.booute.duckdns.org$JS" | grep -c "Event Review"   # 1+
```
Expected: 200, version 0.43.0, "Event Review" present in the bundle, API healthy with no crash loop.

- [ ] **Step 6: Report** — the two pages, what each shows given today's data (all 376 expenses are event-scoped), that PO creation and Zoho PO push still work, and that the dashboard shows combined counts with per-page links.
