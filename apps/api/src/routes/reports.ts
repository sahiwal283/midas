import { Router } from 'express';
import { and, count, eq, gte, inArray, isNull, lte, ne, not, or, sql, sum } from 'drizzle-orm';
import { db } from '../db/index';
import { budgets, expenses, paymentMethods, users, transactions } from '../db/schema';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler, createError } from '../middleware/error';
import { granularityFor, periodKey, fillPeriods } from '../lib/reportBuckets';
import { rollUpByTopAncestor, descendantIds } from '../lib/categoryTree';
import { normalizeMerchant } from '../lib/merchants';

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

  // Category spend rolls up to top-level ancestors so the chart stays readable
  // with a deep tree; raw per-category rows are kept for budget attribution.
  const allCats = await db.query.expenseCategories.findMany({
    columns: { id: true, parentId: true, isActive: true, name: true },
  });
  const catNameOf = (id: string) => allCats.find((c) => c.id === id)?.name ?? 'Unknown';

  const byCategoryRaw = await db.select({ categoryId: expenses.categoryId, spend: sum(expenses.amount), n: count() })
    .from(expenses).where(scope).groupBy(expenses.categoryId);
  const byCategory = rollUpByTopAncestor(
    allCats,
    byCategoryRaw.map((r) => ({ categoryId: r.categoryId, spend: num(r.spend), n: Number(r.n) })),
    catNameOf,
  );

  const byEntity = await db.select({ name: expenses.zohoEntity, spend: sum(expenses.amount), n: count() })
    .from(expenses).where(scope).groupBy(expenses.zohoEntity);

  const bySourceAppRows = await db.select({
    name: expenses.sourceApp,
    spend: sum(expenses.amount),
    n: count(),
  }).from(expenses).where(scope).groupBy(expenses.sourceApp);

  const byPm = await db.select({ name: paymentMethods.label, spend: sum(expenses.amount), n: count() })
    .from(expenses).leftJoin(paymentMethods, eq(expenses.paymentMethodId, paymentMethods.id))
    .where(scope).groupBy(paymentMethods.label);

  // Vendors regroup post-SQL by normalized merchant name so processor
  // decorations ("AMAZON.COM*1A2B3", "SQ *COFFEE") collapse into one vendor.
  const vendorRows = await db.select({ name: expenses.merchant, spend: sum(expenses.amount), n: count() })
    .from(expenses).where(scope).groupBy(expenses.merchant);
  const vendorMap = new Map<string, { name: string; spend: number; count: number }>();
  for (const r of vendorRows) {
    const name = (r.name?.trim() ? normalizeMerchant(r.name) : '') || 'Unknown';
    const cur = vendorMap.get(name) ?? { name, spend: 0, count: 0 };
    cur.spend += num(r.spend);
    cur.count += Number(r.n);
    vendorMap.set(name, cur);
  }
  const topVendors = [...vendorMap.values()]
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10);

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

  // Expense vs PO split from the unified transactions table (same date window).
  const txScope = and(
    not(inArray(transactions.status, ['draft', 'rejected', 'cancelled'])),
    gte(transactions.transactionDate, from),
    lte(transactions.transactionDate, to),
    ...(entity ? [eq(transactions.zohoEntity, entity)] : []),
  );
  const byTxType = await db.select({
    type: transactions.type,
    spend: sum(transactions.total),
    n: count(),
  }).from(transactions).where(txScope).groupBy(transactions.type);

  const [opsPending] = await db.select({ n: count() }).from(expenses)
    .where(and(inArray(expenses.status, ['pending', 'in_review']), eq(expenses.expenseKind, 'business')));
  const [opsAwaiting] = await db.select({ n: count() }).from(expenses)
    .where(and(eq(expenses.status, 'awaiting_info'), eq(expenses.expenseKind, 'business')));
  const [opsZohoFailed] = await db.select({ n: count() }).from(expenses)
    .where(and(eq(expenses.status, 'approved'), eq(expenses.integrationStatus, 'failed'), eq(expenses.expenseKind, 'business')));
  const [opsOcrReview] = await db.select({ n: count() }).from(expenses)
    .where(sql`exists (select 1 from receipts r where r.expense_id = ${expenses.id} and r.ocr_needs_review = true)`);
  const [opsPoQueue] = await db.select({ n: count() }).from(transactions)
    .where(and(
      eq(transactions.type, 'purchase_order'),
      inArray(transactions.status, ['submitted', 'in_review', 'awaiting_info', 'approved']),
      sql`${transactions.integrationStatus} <> 'synced'`,
    ));

  // Budgets overlapping the report window (by calendar month of from/to).
  const monthKeys: string[] = [];
  {
    const cursor = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    while (cursor <= end) {
      monthKeys.push(cursor.toISOString().slice(0, 7));
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }
  const budgetRows = monthKeys.length
    ? await db.query.budgets.findMany({
      where: and(
        inArray(budgets.period, monthKeys),
        ...(entity ? [eq(budgets.companyName, entity)] : []),
      ),
      with: { category: { columns: { id: true, name: true } } },
    })
    : [];

  const spendByEntity = new Map(byEntity.map((r) => [r.name ?? 'Unassigned', num(r.spend)]));
  const budgetVsSpend = budgetRows.map((b) => {
    const budgetAmt = num(b.amount);
    // Category-scoped budgets compare to category spend when category set; else company total in window.
    const spend = b.categoryId
      ? null // filled below from byCategory join when names match company filter — keep company-level for MVP
      : (spendByEntity.get(b.companyName) ?? 0);
    return {
      id: b.id,
      companyName: b.companyName,
      period: b.period,
      budget: budgetAmt,
      spend: spend ?? 0,
      remaining: budgetAmt - (spend ?? 0),
      categoryId: b.categoryId,
      categoryName: b.category?.name ?? null,
      notes: b.notes,
    };
  });

  // For category budgets, attribute spend only when a single company filter is set.
  // A budget on a parent category counts spend from the whole subtree.
  if (entity) {
    for (const row of budgetVsSpend) {
      if (!row.categoryId) continue;
      const ids = new Set(descendantIds(allCats, row.categoryId));
      row.spend = byCategoryRaw
        .filter((r) => r.categoryId && ids.has(r.categoryId))
        .reduce((s, r) => s + num(r.spend), 0);
      row.remaining = row.budget - row.spend;
    }
  }

  res.json({
    totals: { spend: spendTotal, count: n, avg: n > 0 ? spendTotal / n : 0, reimbursementPending: num(totalsRow?.reimb) },
    byTransactionType: byTxType.map((r) => ({
      type: r.type,
      spend: num(r.spend),
      count: Number(r.n),
    })),
    ops: {
      pendingReview: Number(opsPending?.n ?? 0),
      awaitingInfo: Number(opsAwaiting?.n ?? 0),
      zohoFailed: Number(opsZohoFailed?.n ?? 0),
      ocrNeedsReview: Number(opsOcrReview?.n ?? 0),
      purchaseOrdersOpen: Number(opsPoQueue?.n ?? 0),
    },
    budgets: budgetVsSpend,
    granularity,
    byPeriod: fillPeriods(from, to, granularity, periodMap),
    byCategory: mapRows(byCategory, 'Uncategorized'),
    byEntity: mapRows(byEntity, 'Unassigned'),
    bySourceApp: mapRows(
      bySourceAppRows.map((r) => ({
        name: r.name === 'browser_extension' ? 'Browser extension' : r.name,
        spend: r.spend,
        n: r.n,
      })),
      'Midas (manual)',
    ),
    byPaymentMethod: mapRows(byPm, 'Unspecified'),
    topVendors,
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
