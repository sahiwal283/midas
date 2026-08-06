import { Router } from 'express';
import { and, count, eq, gte, inArray, lte, not, sql, sum } from 'drizzle-orm';
import { db } from '../db/index';
import { expenses, expenseCategories, paymentMethods, users } from '../db/schema';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler, createError } from '../middleware/error';
import { granularityFor, periodKey, fillPeriods } from '../lib/reportBuckets';

const router = Router();
router.use(authenticate, requireRole('accountant', 'admin'));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Company-wide aggregates for the Reports page. Scope: committed spend
// (everything except drafts and rejected) within [from, to].
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
    spend: sum(expenses.amount),
    n: count(),
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
