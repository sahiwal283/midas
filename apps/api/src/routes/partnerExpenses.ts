import { Router } from 'express';
import { and, desc, eq, gte, inArray, lte, max, min, not, sum, count } from 'drizzle-orm';
import { db } from '../db/index';
import { expenses } from '../db/schema';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler, createError } from '../middleware/error';
import { effectiveDateRange, summarisePartnerRows } from '../lib/partnerSummary';
import { rollUpByTopAncestor } from '../lib/categoryTree';
import { granularityFor, periodKey, fillPeriods } from '../lib/reportBuckets';

const router = Router();
router.use(authenticate, requireRole('partner', 'accountant', 'admin'));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Partner spend is shared across partners — everyone permitted sees all of it.
 * Excludes draft (not yet submitted), rejected and cancelled — the same
 * "committed spend" bar Reports holds business expenses to — so an abandoned
 * draft doesn't inflate the header total or any of the three charts.
 */
function scope(from?: string, to?: string) {
  const conds = [
    eq(expenses.expenseKind, 'partner'),
    not(inArray(expenses.status, ['draft', 'rejected', 'cancelled'])),
  ];
  if (from) conds.push(gte(expenses.date, from));
  if (to) conds.push(lte(expenses.date, to));
  return and(...conds);
}

function range(req: { query: Record<string, unknown> }) {
  // An empty string (e.g. a page that always sends `from=&to=`) is treated the
  // same as an absent param — `scope()` already ignores falsy from/to, so this
  // doesn't change `GET /`'s behaviour, it just makes `/summary`'s "no range
  // supplied" branch robust to both shapes.
  const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : undefined;
  return { from, to };
}

router.get('/', asyncHandler(async (req, res) => {
  const { from, to } = range(req);
  if (from !== undefined && !DATE_RE.test(from)) {
    throw createError('from must be YYYY-MM-DD', 400, 'INVALID_RANGE');
  }
  if (to !== undefined && !DATE_RE.test(to)) {
    throw createError('to must be YYYY-MM-DD', 400, 'INVALID_RANGE');
  }
  if (from !== undefined && to !== undefined && from > to) {
    throw createError('from must be <= to', 400, 'INVALID_RANGE');
  }
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
  if (from !== undefined && !DATE_RE.test(from)) {
    throw createError('from must be YYYY-MM-DD', 400, 'INVALID_RANGE');
  }
  if (to !== undefined && !DATE_RE.test(to)) {
    throw createError('to must be YYYY-MM-DD', 400, 'INVALID_RANGE');
  }
  if (from !== undefined && to !== undefined && from > to) {
    throw createError('from must be <= to', 400, 'INVALID_RANGE');
  }

  // No explicit range (the page's default state): fall back to the min/max
  // date across all partner expenses so the summary matches the unfiltered
  // table. Zero partner expenses is a real state (e.g. first deploy) — not
  // an error — so it resolves to an empty, zeroed-out summary below.
  const [bounds] = await db.select({ min: min(expenses.date), max: max(expenses.date) })
    .from(expenses).where(scope());
  const resolved = effectiveDateRange(from, to, { min: bounds?.min ?? null, max: bounds?.max ?? null });

  if (!resolved) {
    res.json({
      totals: { spend: 0, count: 0 },
      granularity: 'month',
      byCategory: [],
      byPeriod: [],
      byPerson: [],
    });
    return;
  }
  const { from: effFrom, to: effTo } = resolved;

  const where = scope(effFrom, effTo);
  const num = (v: unknown) => Number(v ?? 0);

  const [totalsRow] = await db.select({ spend: sum(expenses.amount), n: count() })
    .from(expenses).where(where);

  const allCats = await db.query.expenseCategories.findMany({
    columns: { id: true, parentId: true, isActive: true, name: true },
  });
  const byCategoryRaw = await db.select({
    categoryId: expenses.categoryId, spend: sum(expenses.amount), n: count(),
  }).from(expenses).where(where).groupBy(expenses.categoryId);
  const byCategoryRolled = rollUpByTopAncestor(
    allCats,
    byCategoryRaw.map((r) => ({ categoryId: r.categoryId, spend: num(r.spend), n: Number(r.n) })),
    (id) => allCats.find((c) => c.id === id)?.name ?? 'Unknown',
  );
  const byCategory = byCategoryRolled
    .map((r) => ({ name: r.name, spend: r.spend, count: r.n }))
    .sort((a, b) => b.spend - a.spend);

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
  const granularity = granularityFor(effFrom, effTo);
  const periodMap = new Map<string, { spend: number; count: number }>();
  for (const r of byDate) {
    const key = periodKey(r.date, granularity);
    const cur = periodMap.get(key) ?? { spend: 0, count: 0 };
    periodMap.set(key, { spend: cur.spend + num(r.spend), count: cur.count + Number(r.n) });
  }
  const byPeriod = fillPeriods(effFrom, effTo, granularity, periodMap);

  res.json({
    totals: { spend: num(totalsRow?.spend), count: Number(totalsRow?.n ?? 0) },
    granularity,
    byCategory,
    byPeriod,
    byPerson,
  });
}));

export default router;
