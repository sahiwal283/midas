# Reports Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Company-wide Reports page (accountant/admin/dev) with time filters, KPI tiles, Recharts charts, and top-vendor/spender tables.

**Architecture:** One aggregate endpoint (`GET /reports/summary`) doing SQL GROUP BYs; pure period-bucketing lib with tests; a single Reports page consuming one query. Charts use the dataviz-validated categorical palette (fixed slot order, fold >8 to "Other", legend + value labels satisfy the contrast relief rule); app chrome stays Midas gold.

**Tech Stack:** Express + Drizzle SQL aggregates, React + TanStack Query + Recharts 2.x.

**Spec:** `docs/superpowers/specs/2026-08-06-reports-page-design.md`

## Global Constraints

- Endpoint scope: `status NOT IN ('draft','rejected')`, `date BETWEEN from AND to`, optional `zoho_entity = entity`.
- `from`/`to` required `YYYY-MM-DD`, `from <= to`, span ≤ 366 days → else 400 `INVALID_RANGE`.
- Granularity: `'week'` iff span ≤ 62 days else `'month'`; buckets zero-filled.
- Series palette (fixed order): `#2a78d6, #eb6834, #1baf7a, #eda100, #e87ba4, #008300, #4a3aa7, #e34948` — never cycled; >8 categories fold into "Other" (`#9ca3af`).
- One axis per chart; thin marks; rounded ends; legend text in gray ink, never series color.
- Suite has 2 pre-existing failures (`zohoReadiness`, `mapOcrError`).

---

### Task 1: `lib/reportBuckets.ts` (TDD)

**Files:** Create `apps/api/src/lib/reportBuckets.ts`; Test `apps/api/src/__tests__/reportBuckets.test.ts`

**Interfaces (produces):**

```ts
export function granularityFor(from: string, to: string): 'week' | 'month'
export function periodKey(date: string, g: 'week' | 'month'): string   // '2026-03' | '2026-W12'
export function periodLabel(key: string): string                        // 'Mar 2026' | 'Wk of Mar 16'
export function listPeriods(from: string, to: string, g: 'week' | 'month'): string[]
export function fillPeriods(
  from: string, to: string, g: 'week' | 'month',
  rows: Map<string, { spend: number; count: number }>,
): Array<{ period: string; label: string; spend: number; count: number }>
```

ISO week: weeks start Monday; key year is the ISO week-numbering year.

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { granularityFor, periodKey, periodLabel, listPeriods, fillPeriods } from '../lib/reportBuckets';

describe('granularityFor', () => {
  it('week for spans ≤ 62 days, month above', () => {
    expect(granularityFor('2026-01-01', '2026-02-28')).toBe('week');
    expect(granularityFor('2026-01-01', '2026-03-15')).toBe('month');
  });
});

describe('periodKey', () => {
  it('month keys', () => {
    expect(periodKey('2026-03-09', 'month')).toBe('2026-03');
  });
  it('ISO week keys (Monday start, ISO year)', () => {
    expect(periodKey('2026-03-09', 'week')).toBe('2026-W11');
    expect(periodKey('2026-01-01', 'week')).toBe('2026-W01');
    expect(periodKey('2027-01-01', 'week')).toBe('2026-W53'); // 2027-01-01 is a Friday in ISO week 53 of 2026
  });
});

describe('periodLabel', () => {
  it('labels months and weeks', () => {
    expect(periodLabel('2026-03')).toBe('Mar 2026');
    expect(periodLabel('2026-W11')).toBe('Wk of Mar 9');
  });
});

describe('listPeriods / fillPeriods', () => {
  it('lists contiguous months across a year boundary', () => {
    expect(listPeriods('2025-11-15', '2026-02-10', 'month')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });
  it('zero-fills gaps', () => {
    const rows = new Map([['2025-12', { spend: 100, count: 2 }]]);
    const out = fillPeriods('2025-11-15', '2026-01-20', 'month', rows);
    expect(out.map((p) => p.spend)).toEqual([0, 100, 0]);
    expect(out[1]).toMatchObject({ period: '2025-12', label: 'Dec 2025' });
  });
  it('lists contiguous ISO weeks', () => {
    expect(listPeriods('2026-03-02', '2026-03-20', 'week')).toEqual(['2026-W10', '2026-W11', '2026-W12']);
  });
});
```

- [ ] **Step 2:** Run → FAIL (module not found).
- [ ] **Step 3: Implement** (pure date math on UTC to avoid TZ drift):

```ts
/** Period bucketing for /reports/summary. All date strings are YYYY-MM-DD. */

const DAY_MS = 86_400_000;

function parseUTC(d: string): Date { return new Date(`${d}T00:00:00Z`); }

export function granularityFor(from: string, to: string): 'week' | 'month' {
  const span = (parseUTC(to).getTime() - parseUTC(from).getTime()) / DAY_MS;
  return span <= 62 ? 'week' : 'month';
}

/** ISO week number + ISO week-numbering year (weeks start Monday). */
function isoWeek(d: Date): { year: number; week: number } {
  const t = new Date(d.getTime());
  const day = (t.getUTCDay() + 6) % 7;            // Mon=0..Sun=6
  t.setUTCDate(t.getUTCDate() - day + 3);         // nearest Thursday
  const isoYear = t.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const week1Mon = new Date(jan4.getTime() - jan4Day * DAY_MS);
  const week = 1 + Math.round((t.getTime() - 3 * DAY_MS - week1Mon.getTime()) / (7 * DAY_MS));
  return { year: isoYear, week };
}

/** Monday of the ISO week containing d. */
function weekStart(d: Date): Date {
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - day * DAY_MS);
}

export function periodKey(date: string, g: 'week' | 'month'): string {
  const d = parseUTC(date);
  if (g === 'month') return date.slice(0, 7);
  const { year, week } = isoWeek(d);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function periodLabel(key: string): string {
  const weekMatch = /^(\d{4})-W(\d{2})$/.exec(key);
  if (weekMatch) {
    const [, y, w] = weekMatch;
    const jan4 = new Date(Date.UTC(Number(y), 0, 4));
    const monday = new Date(weekStart(jan4).getTime() + (Number(w) - 1) * 7 * DAY_MS);
    return `Wk of ${MONTHS[monday.getUTCMonth()]} ${monday.getUTCDate()}`;
  }
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export function listPeriods(from: string, to: string, g: 'week' | 'month'): string[] {
  const keys: string[] = [];
  if (g === 'month') {
    let [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
    const [ey, em] = [Number(to.slice(0, 4)), Number(to.slice(5, 7))];
    while (y < ey || (y === ey && m <= em)) {
      keys.push(`${y}-${String(m).padStart(2, '0')}`);
      m += 1; if (m > 12) { m = 1; y += 1; }
    }
    return keys;
  }
  let cursor = weekStart(parseUTC(from));
  const end = weekStart(parseUTC(to));
  while (cursor.getTime() <= end.getTime()) {
    const { year, week } = isoWeek(cursor);
    keys.push(`${year}-W${String(week).padStart(2, '0')}`);
    cursor = new Date(cursor.getTime() + 7 * DAY_MS);
  }
  return keys;
}

export function fillPeriods(
  from: string, to: string, g: 'week' | 'month',
  rows: Map<string, { spend: number; count: number }>,
): Array<{ period: string; label: string; spend: number; count: number }> {
  return listPeriods(from, to, g).map((period) => ({
    period,
    label: periodLabel(period),
    spend: rows.get(period)?.spend ?? 0,
    count: rows.get(period)?.count ?? 0,
  }));
}
```

- [ ] **Step 4:** Run → PASS. **Step 5:** Commit `feat(api): report period bucketing lib`.

---

### Task 2: `routes/reports.ts` + mount

**Files:** Create `apps/api/src/routes/reports.ts`; Modify `apps/api/src/server.ts`.

**Interfaces:** Consumes Task 1. Produces the spec's response shape at `GET /api/v1/reports/summary`.

- [ ] **Step 1: Router** (aggregate in SQL; JS-side only for period fill):

```ts
import { Router } from 'express';
import { and, eq, gte, inArray, lte, not, sql, sum, count } from 'drizzle-orm';
import { db } from '../db/index';
import { expenses, expenseCategories, paymentMethods, users } from '../db/schema';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler, createError } from '../middleware/error';
import { granularityFor, periodKey, fillPeriods } from '../lib/reportBuckets';

const router = Router();
router.use(authenticate, requireRole('accountant', 'admin'));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get('/summary', asyncHandler(async (req, res) => {
  const { from, to, entity } = req.query as Record<string, string | undefined>;
  if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
    throw createError('from/to must be YYYY-MM-DD with from <= to', 400, 'INVALID_RANGE');
  }
  const spanDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (spanDays > 366) throw createError('Range must be at most 366 days', 400, 'INVALID_RANGE');

  const scope = and(
    not(inArray(expenses.status, ['draft', 'rejected'])),
    gte(expenses.date, from),
    lte(expenses.date, to),
    ...(entity ? [eq(expenses.zohoEntity, entity)] : []),
  );

  const num = (v: unknown) => Number(v ?? 0);

  const [totalsRow] = await db.select({
    spend: sum(expenses.amount), n: count(),
    reimb: sql<string>`coalesce(sum(${expenses.amount}) filter (where ${expenses.reimbursementStatus} = 'pending'), 0)`,
  }).from(expenses).where(scope);

  const byDate = await db.select({ date: expenses.date, spend: sum(expenses.amount), n: count() })
    .from(expenses).where(scope).groupBy(expenses.date);

  const byCategory = await db.select({ name: expenseCategories.name, spend: sum(expenses.amount), n: count() })
    .from(expenses).leftJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
    .where(scope).groupBy(expenseCategories.name);

  const byEntity = await db.select({ name: expenses.zohoEntity, spend: sum(expenses.amount), n: count() })
    .from(expenses).where(scope).groupBy(expenses.zohoEntity);

  const byPm = await db.select({ name: paymentMethods.label, spend: sum(expenses.amount), n: count() })
    .from(expenses).leftJoin(paymentMethods, eq(expenses.paymentMethodId, paymentMethods.id))
    .where(scope).groupBy(paymentMethods.label);

  const topVendors = await db.select({ name: expenses.merchant, spend: sum(expenses.amount), n: count() })
    .from(expenses).where(scope).groupBy(expenses.merchant)
    .orderBy(sql`sum(${expenses.amount}) desc`).limit(10);

  const topUsers = await db.select({ name: users.name, spend: sum(expenses.amount), n: count() })
    .from(expenses).innerJoin(users, eq(expenses.userId, users.id))
    .where(scope).groupBy(users.name)
    .orderBy(sql`sum(${expenses.amount}) desc`).limit(10);

  const granularity = granularityFor(from, to);
  const periodMap = new Map<string, { spend: number; count: number }>();
  for (const r of byDate) {
    const key = periodKey(r.date, granularity);
    const cur = periodMap.get(key) ?? { spend: 0, count: 0 };
    periodMap.set(key, { spend: cur.spend + num(r.spend), count: cur.count + Number(r.n) });
  }

  const mapRows = (rows: Array<{ name: string | null; spend: unknown; n: unknown }>, fallback: string) =>
    rows.map((r) => ({ name: r.name ?? fallback, spend: num(r.spend), count: Number(r.n) }))
      .sort((a, b) => b.spend - a.spend);

  const spendTotal = num(totalsRow?.spend);
  const n = Number(totalsRow?.n ?? 0);
  res.json({
    totals: { spend: spendTotal, count: n, avg: n > 0 ? spendTotal / n : 0, reimbursementPending: num(totalsRow?.reimb) },
    granularity,
    byPeriod: fillPeriods(from, to, granularity, periodMap),
    byCategory: mapRows(byCategory, 'Uncategorized'),
    byEntity: mapRows(byEntity, 'Unassigned'),
    byPaymentMethod: mapRows(byPm, 'Unspecified'),
    topVendors: mapRows(topVendors, 'Unknown'),
    topUsers: mapRows(topUsers, 'Unknown'),
  });
}));

export default router;
```

- [ ] **Step 2: Mount** in `server.ts`: `import reportsRouter from './routes/reports';` + `app.use('/api/v1/reports', reportsRouter);` (after partner-expenses mount).
- [ ] **Step 3:** `npm run lint` + `npm run test` → clean/no new failures. **Step 4:** Commit `feat(api): reports summary endpoint`.

---

### Task 3: Web plumbing — recharts, api module, ranges lib, nav, route

**Files:** Modify `apps/web/package.json` (add `"recharts": "^2.13.3"`); Create `apps/web/src/api/reports.ts`, `apps/web/src/lib/reportRanges.ts`; Modify `apps/web/src/components/Sidebar.tsx`, `apps/web/src/App.tsx`.

- [ ] **Step 1:** `cd apps/web && npm install recharts@^2.13.3`
- [ ] **Step 2: api module**

```ts
import client from './client';

export interface ReportRow { name: string; spend: number; count: number }
export interface ReportSummary {
  totals: { spend: number; count: number; avg: number; reimbursementPending: number };
  granularity: 'week' | 'month';
  byPeriod: Array<{ period: string; label: string; spend: number; count: number }>;
  byCategory: ReportRow[];
  byEntity: ReportRow[];
  byPaymentMethod: ReportRow[];
  topVendors: ReportRow[];
  topUsers: ReportRow[];
}

export const reportApi = {
  summary: (p: { from: string; to: string; entity?: string }) =>
    client.get<ReportSummary>('/reports/summary', { params: p }).then((r) => r.data),
};
```

- [ ] **Step 3: ranges lib** (local time; `fmt` = YYYY-MM-DD):

```ts
export interface DateRange { from: string; to: string }

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function quarterRange(year: number, q: 1 | 2 | 3 | 4): DateRange {
  const startMonth = (q - 1) * 3;
  return { from: fmt(new Date(year, startMonth, 1)), to: fmt(new Date(year, startMonth + 3, 0)) };
}

export function presetRange(preset: string, now: Date = new Date()): DateRange {
  const y = now.getFullYear();
  const q = (Math.floor(now.getMonth() / 3) + 1) as 1 | 2 | 3 | 4;
  switch (preset) {
    case 'this_month': return { from: fmt(new Date(y, now.getMonth(), 1)), to: fmt(new Date(y, now.getMonth() + 1, 0)) };
    case 'last_month': return { from: fmt(new Date(y, now.getMonth() - 1, 1)), to: fmt(new Date(y, now.getMonth(), 0)) };
    case 'this_quarter': return quarterRange(y, q);
    case 'last_quarter': return q === 1 ? quarterRange(y - 1, 4) : quarterRange(y, (q - 1) as 1 | 2 | 3);
    case 'q1': return quarterRange(y, 1);
    case 'q2': return quarterRange(y, 2);
    case 'q3': return quarterRange(y, 3);
    case 'q4': return quarterRange(y, 4);
    case 'ytd': return { from: fmt(new Date(y, 0, 1)), to: fmt(now) };
    default: return { from: fmt(new Date(y, 0, 1)), to: fmt(now) };
  }
}

export const PRESETS: Array<{ id: string; label: string }> = [
  { id: 'this_month', label: 'This month' },
  { id: 'last_month', label: 'Last month' },
  { id: 'this_quarter', label: 'This quarter' },
  { id: 'last_quarter', label: 'Last quarter' },
  { id: 'q1', label: 'Q1' }, { id: 'q2', label: 'Q2' }, { id: 'q3', label: 'Q3' }, { id: 'q4', label: 'Q4' },
  { id: 'ytd', label: 'YTD' },
];
```

- [ ] **Step 4: Nav + route.** Sidebar: add `BarChart3` to lucide imports; inside the existing `isPrivileged` block, after Review Queue: `<NavLink to="/reports" className={linkClass}><BarChart3 className="h-4 w-4" />Reports</NavLink>`. App.tsx: import `Reports`, add route `/reports` with `ProtectedRoute roles={['accountant', 'admin', 'developer']}` (page created in Task 4; commit together).

---

### Task 4: `Reports.tsx`

**Files:** Create `apps/web/src/pages/Reports.tsx`.

Layout per spec: filter bar (preset chips styled like ExpenseList status tabs, two native date inputs, entity `<select>`), 4 KPI tiles (existing stat-tile card style), spend-over-time `<BarChart>` (slot-1 blue `#2a78d6`, rounded top ends `radius={[4,4,0,0]}`, thin bars `maxBarSize={40}`, `CartesianGrid` horizontal-only `stroke="#f3f4f6"`, tooltip), category `<PieChart>` donut (inner/outer radius, palette slots in fixed order, >8 folds to "Other" `#9ca3af`, legend right with gray text + dollar values), entity + payment-method horizontal bars (`layout="vertical"`, slot colors by entity identity, value labels), top vendors/spenders tables with share bars (gold `bg-brand-300`). Empty state ("No expenses in this range") and loading state. Currency via `toLocaleString` with 2 decimals. All chart text gray ink (`#6b7280`/`#374151`), never series colors.

- [ ] **Step 1:** Implement page (full code at executor's discretion following the constraints above — the palette, mark, one-axis, legend rules are non-negotiable).
- [ ] **Step 2:** `npm run lint` (web) → clean.
- [ ] **Step 3:** Commit Tasks 3+4 together: `feat(web): reports page with time filters and charts`.

---

### Task 5: Verify, version, ship

- [ ] **Step 1:** Root `npm run lint` → 0 errors; `apps/api` tests → only 2 pre-existing failures.
- [ ] **Step 2:** Bump 0.6.0-alpha → 0.7.0-alpha (3 package.json + version.ts) + CHANGELOG; commit.
- [ ] **Step 3:** Merge to main, push. Deploy: tarball API files + web src + **apps/web/package.json + package-lock.json** → CT 3120; API hot-reloads; **web requires prod rebuild** (`docker compose -f docker-compose.prod.yml up -d --no-deps --build web`) because of the new dependency; verify meta 0.7.0-alpha + web 200 + smoke `GET /reports/summary` as accountant-capable user (partner is 403 — use dev/admin if creds available, else verify 403 gate + rely on UI).
- [ ] **Step 4:** Render check — screenshot or user eyeballs the page (dataviz step 7).
