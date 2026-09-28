// Client-side drill-down for the trade-show breakdown report. The endpoint
// returns every expense row for a show, so clicking a company box or
// ticking categories can re-aggregate locally instead of round-tripping —
// mirroring the trade show app's report, where the whole page narrows to
// what you clicked.
//
// Aggregation rules match apps/api/src/routes/reports.ts (event-breakdown)
// exactly: unassigned company → 'Unassigned', missing category →
// 'Uncategorized', approved counts 'approved' + 'zoho_sync_failed', both
// lists sorted by spend descending.

import type { EventBreakdown } from '../api/reports';

export type BreakdownRow = EventBreakdown['expenses'][number];

export type BreakdownFilter = {
  /** Company (zohoEntity) to scope to, or null for all. 'Unassigned' is valid. */
  company: string | null;
  /** Category names to keep; empty means all. */
  categories: string[];
};

export const EMPTY_FILTER: BreakdownFilter = { company: null, categories: [] };

export const UNASSIGNED = 'Unassigned';
export const UNCATEGORIZED = 'Uncategorized';

export function rowCompany(e: BreakdownRow): string {
  return e.zohoEntity ?? UNASSIGNED;
}

export function rowCategory(e: BreakdownRow): string {
  return e.categoryName ?? UNCATEGORIZED;
}

export function isFilterEmpty(f: BreakdownFilter): boolean {
  return f.company === null && f.categories.length === 0;
}

export type DerivedBreakdown = Pick<EventBreakdown, 'totals' | 'byEntity' | 'categories' | 'expenses'>;

/** Filter the rows and rebuild every aggregate the breakdown panels show. */
export function deriveBreakdown(rows: readonly BreakdownRow[], filter: BreakdownFilter): DerivedBreakdown {
  const wanted = new Set(filter.categories);
  const expenses = rows.filter((e) =>
    (filter.company === null || rowCompany(e) === filter.company)
    && (wanted.size === 0 || wanted.has(rowCategory(e))),
  );

  const entityTotals = new Map<string, { spend: number; count: number }>();
  const matrix = new Map<string, Map<string, number>>();
  let spend = 0;
  let approved = 0;
  let pending = 0;
  for (const e of expenses) {
    spend += e.amount;
    if (e.status === 'approved' || e.status === 'zoho_sync_failed') approved += 1;
    else pending += 1;
    const company = rowCompany(e);
    const et = entityTotals.get(company) ?? { spend: 0, count: 0 };
    et.spend += e.amount;
    et.count += 1;
    entityTotals.set(company, et);
    const cat = rowCategory(e);
    const cells = matrix.get(cat) ?? new Map<string, number>();
    cells.set(company, (cells.get(company) ?? 0) + e.amount);
    matrix.set(cat, cells);
  }

  const byEntity = [...entityTotals.entries()]
    .map(([name, v]) => ({ name, spend: v.spend, count: v.count }))
    .sort((a, b) => b.spend - a.spend);

  const categories = [...matrix.entries()]
    .map(([category, cells]) => ({
      category,
      byEntity: Object.fromEntries(cells),
      total: [...cells.values()].reduce((s, v) => s + v, 0),
    }))
    .sort((a, b) => b.total - a.total);

  return {
    totals: { spend, count: expenses.length, approved, pending },
    byEntity,
    categories,
    expenses,
  };
}

// ── URL state ────────────────────────────────────────────────────────────────
// Lives next to `?show=` so a drilled-down view is linkable and the browser
// back button unwinds it. Categories are repeated `cat` params, never
// comma-joined — category names contain commas.

const COMPANY_PARAM = 'company';
const CATEGORY_PARAM = 'cat';

export function parseBreakdownFilter(params: URLSearchParams): BreakdownFilter {
  return {
    company: params.get(COMPANY_PARAM),
    categories: params.getAll(CATEGORY_PARAM),
  };
}

/** Write the filter into `params` in place, removing keys that are empty. */
export function serializeBreakdownFilter(params: URLSearchParams, filter: BreakdownFilter): URLSearchParams {
  if (filter.company) params.set(COMPANY_PARAM, filter.company);
  else params.delete(COMPANY_PARAM);
  params.delete(CATEGORY_PARAM);
  for (const c of filter.categories) params.append(CATEGORY_PARAM, c);
  return params;
}
