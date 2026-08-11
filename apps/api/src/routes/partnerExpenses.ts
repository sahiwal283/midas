import { Router } from 'express';
import { and, desc, eq, gte, lte, sum, count } from 'drizzle-orm';
import { db } from '../db/index';
import { expenses } from '../db/schema';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler, createError } from '../middleware/error';
import { summarisePartnerRows } from '../lib/partnerSummary';
import { rollUpByTopAncestor } from '../lib/categoryTree';
import { granularityFor, periodKey, fillPeriods } from '../lib/reportBuckets';

const router = Router();
router.use(authenticate, requireRole('partner', 'accountant', 'admin'));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
    throw createError('from/to must be YYYY-MM-DD with from <= to', 400, 'INVALID_RANGE');
  }
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
  const granularity = granularityFor(from, to);
  const periodMap = new Map<string, { spend: number; count: number }>();
  for (const r of byDate) {
    const key = periodKey(r.date, granularity);
    const cur = periodMap.get(key) ?? { spend: 0, count: 0 };
    periodMap.set(key, { spend: cur.spend + num(r.spend), count: cur.count + Number(r.n) });
  }
  const byPeriod = fillPeriods(from, to, granularity, periodMap);

  res.json({
    totals: { spend: num(totalsRow?.spend), count: Number(totalsRow?.n ?? 0) },
    granularity,
    byCategory,
    byPeriod,
    byPerson,
  });
}));

export default router;
