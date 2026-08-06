# Reports Page — Design

**Date:** 2026-08-06
**Status:** Approved

## Purpose

A professional, company-wide Reports page for accountant/admin/developer: time
filters (presets + custom range), KPI tiles, and charts of spend across time,
category, entity, payment method, plus top vendors/spenders.

## API

`GET /api/v1/reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD[&entity=<zohoEntity>]`
— new router `apps/api/src/routes/reports.ts`, `requireRole('accountant', 'admin')`
(developer passes). `from`/`to` required, validated `YYYY-MM-DD`, `from <= to`,
range ≤ 366 days (400 `INVALID_RANGE` otherwise).

**Scope:** expenses with `status NOT IN ('draft', 'rejected')` and
`date BETWEEN from AND to`; optional `entity` filter on `zoho_entity`.

**Response** (all amounts as numbers, dollars):

```ts
{
  totals: { spend: number; count: number; avg: number; reimbursementPending: number },
  granularity: 'week' | 'month',      // week when range ≤ 62 days
  byPeriod:  Array<{ period: string; label: string; spend: number; count: number }>, // zero-filled
  byCategory: Array<{ name: string; spend: number; count: number }>,   // uncategorized → 'Uncategorized'
  byEntity:   Array<{ name: string; spend: number; count: number }>,   // null → 'Unassigned'
  byPaymentMethod: Array<{ name: string; spend: number; count: number }>, // null → 'Unspecified'
  topVendors: Array<{ name: string; spend: number; count: number }>,   // top 10 by spend
  topUsers:   Array<{ name: string; spend: number; count: number }>,   // top 10 by spend
}
```

Aggregation is SQL `GROUP BY` via drizzle; period bucketing/zero-filling is a pure
lib `apps/api/src/lib/reportBuckets.ts`:

```ts
periodKey(date: string, g: 'week' | 'month'): string        // '2026-03' | '2026-W12' (ISO week)
periodLabel(key: string): string                            // 'Mar 2026' | 'Wk of Mar 16'
granularityFor(from: string, to: string): 'week' | 'month'  // week iff ≤ 62 days
fillPeriods(from: string, to: string, g, rows: Map<string, {spend, count}>): byPeriod[]
```

`reimbursementPending` = sum of amount where `reimbursement_status = 'pending'`
within the same scope.

## Web

- Route `/reports` (`ProtectedRoute roles={['accountant', 'admin', 'developer']}`),
  sidebar link **Reports** (BarChart3 icon) in the Accountant section.
- New dependency: `recharts` (^2.x) in `apps/web`.
- `apps/web/src/api/reports.ts` — `reportApi.summary({from, to, entity?})`.
- `apps/web/src/lib/reportRanges.ts` — pure preset math: This month, Last month,
  This quarter, Last quarter, Q1–Q4 (current year), YTD → `{from, to}` (local dates).
- `apps/web/src/pages/Reports.tsx`:
  - Filter bar: preset chips + custom from/to date inputs + entity dropdown
    (entities derived from the summary response's byEntity names + 'All').
  - KPI tiles: Total spend, Expenses, Average, Reimbursements pending.
  - Spend over time — vertical bar chart (full width).
  - By category — donut; by entity — horizontal bars (two-column row).
  - By payment method — horizontal bars.
  - Top vendors / Top spenders — ranked tables with amount + share bar.
- Charts follow the dataviz skill: single accent family + neutral greys,
  categorical palette validated for contrast, no default-Recharts look; cards match
  the app's existing white rounded-xl style; loading and empty states included.

## Testing

`apps/api/src/__tests__/reportBuckets.test.ts` — granularity threshold, month and
ISO-week keys, zero-fill continuity across month/year boundaries, label formats.
Web verified by `npm run lint` (tsc) and visual review.

## Out of scope

CSV/PDF export, per-user personal reports, partner-expense reporting, saved or
shareable report links, comparisons vs prior period.
