import { Router } from 'express';
import { and, count, eq, gte, inArray, isNull, lte, ne, not, or, sql, sum } from 'drizzle-orm';
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
  const { from, to, entity, type } = req.query as Record<string, string | undefined>;
  if (type !== undefined && type !== 'daily' && type !== 'event') {
    throw createError("type must be 'daily' or 'event'", 400, 'INVALID_TYPE');
  }
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
    // Daily = entered in Midas or via the extension; event = any external app
    // (trade_show, …) — the same boundary the auto-push feature uses.
    ...(type === 'daily'
      ? [or(isNull(expenses.sourceApp), eq(expenses.sourceApp, 'browser_extension'))]
      : []),
    ...(type === 'event'
      ? [and(sql`${expenses.sourceApp} is not null`, ne(expenses.sourceApp, 'browser_extension'))]
      : []),
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

  const byReimb = await db.select({ status: expenses.reimbursementStatus, spend: sum(expenses.amount) })
    .from(expenses).where(scope).groupBy(expenses.reimbursementStatus);
  const reimbByEmployee = await db.select({ name: users.name, status: expenses.reimbursementStatus, spend: sum(expenses.amount) })
    .from(expenses).innerJoin(users, eq(expenses.userId, users.id))
    .where(and(scope, inArray(expenses.reimbursementStatus, ['pending', 'approved', 'paid'])))
    .groupBy(users.name, expenses.reimbursementStatus);

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
    reimbursement: (() => {
      const byStatus = new Map(byReimb.map((r) => [r.status, num(r.spend)]));
      const employees = new Map<string, { name: string; outstanding: number; paid: number }>();
      for (const r of reimbByEmployee) {
        const e = employees.get(r.name) ?? { name: r.name, outstanding: 0, paid: 0 };
        if (r.status === 'paid') e.paid += num(r.spend);
        else e.outstanding += num(r.spend);
        employees.set(r.name, e);
      }
      return {
        reimbursableTotal: (byStatus.get('pending') ?? 0) + (byStatus.get('approved') ?? 0) + (byStatus.get('paid') ?? 0) + (byStatus.get('rejected') ?? 0),
        companyCardTotal: byStatus.get('not_requested') ?? 0,
        outstanding: (byStatus.get('pending') ?? 0) + (byStatus.get('approved') ?? 0),
        paid: byStatus.get('paid') ?? 0,
        byEmployee: [...employees.values()].sort((a, b) => b.outstanding - a.outstanding).slice(0, 10),
      };
    })(),
  });
}));

export default router;
