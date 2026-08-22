import { Router } from 'express';
import { and, count, eq, gte, inArray, lte, not, sql, sum } from 'drizzle-orm';
import { db } from '../db/index';
import { budgets, expenses, paymentMethods, users, transactions } from '../db/schema';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler, createError } from '../middleware/error';
import { granularityFor, periodKey, fillPeriods } from '../lib/reportBuckets';
import { rollUpByTopAncestor, descendantIds, topLevelAncestorId } from '../lib/categoryTree';
import { normalizeMerchant } from '../lib/merchants';
import { scopeCondition } from '../lib/queueScope';

const router = Router();
router.use(authenticate, requireRole('accountant', 'admin'));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Company-wide aggregates for the Reports page. Scope: committed spend
// (everything except drafts and rejected) within [from, to].
router.get('/summary', asyncHandler(async (req, res) => {
  const { from, to, entity, type } = req.query as Record<string, string | undefined>;
  if (type !== 'daily' && type !== 'event') {
    throw createError("type must be 'daily' or 'event'", 400, 'INVALID_TYPE');
  }
  if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
    throw createError('from/to must be YYYY-MM-DD with from <= to', 400, 'INVALID_RANGE');
  }
  const spanDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (spanDays > 366) throw createError('Range must be at most 366 days', 400, 'INVALID_RANGE');

  const typeFilter = scopeCondition(type);
  const scope = and(
    // Company-wide Reports is business spend only — partner spend has its own tab.
    eq(expenses.expenseKind, 'business'),
    not(inArray(expenses.status, ['draft', 'rejected'])),
    gte(expenses.date, from),
    lte(expenses.date, to),
    ...(entity ? [eq(expenses.zohoEntity, entity)] : []),
    // Daily and trade-show spend never share a report. Same boundary as the
    // review queues (entered in Midas / extension vs pushed from an external app).
    typeFilter,
  );

  const num = (v: unknown) => Number(v ?? 0);

  const [totalsRow] = await db.select({
    spend: sum(expenses.amount),
    n: count(),
    reimb: sql<string>`coalesce(sum(${expenses.amount}) filter (where ${expenses.reimbursementStatus} = 'pending'), 0)`,
    largest: sql<string>`coalesce(max(${expenses.amount}), 0)`,
    smallest: sql<string>`coalesce(min(${expenses.amount}), 0)`,
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

  const byEventRows = await db.select({
    name: expenses.sourceLabel,
    spend: sum(expenses.amount),
    n: count(),
  }).from(expenses).where(scope).groupBy(expenses.sourceLabel);

  // Per-company split for each show — powers the stacked bars on show tiles.
  const byEventEntityRows = await db.select({
    event: expenses.sourceLabel,
    entity: expenses.zohoEntity,
    spend: sum(expenses.amount),
  }).from(expenses).where(scope).groupBy(expenses.sourceLabel, expenses.zohoEntity);

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
    .where(and(inArray(expenses.status, ['pending', 'in_review']), eq(expenses.expenseKind, 'business'), typeFilter));
  const [opsAwaiting] = await db.select({ n: count() }).from(expenses)
    .where(and(eq(expenses.status, 'awaiting_info'), eq(expenses.expenseKind, 'business'), typeFilter));
  const [opsZohoFailed] = await db.select({ n: count() }).from(expenses)
    .where(and(eq(expenses.status, 'approved'), eq(expenses.integrationStatus, 'failed'), eq(expenses.expenseKind, 'business'), typeFilter));
  const [opsOcrReview] = await db.select({ n: count() }).from(expenses)
    .where(and(
      eq(expenses.expenseKind, 'business'),
      typeFilter,
      sql`exists (select 1 from receipts r where r.expense_id = ${expenses.id} and r.ocr_needs_review = true)`,
    ));
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
    totals: {
      spend: spendTotal,
      count: n,
      avg: n > 0 ? spendTotal / n : 0,
      reimbursementPending: num(totalsRow?.reimb),
      largest: num(totalsRow?.largest),
      smallest: num(totalsRow?.smallest),
    },
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
    byEvent: mapRows(byEventRows, 'Unlabeled show').map((row) => ({
      ...row,
      entities: byEventEntityRows
        .filter((r) => (r.event ?? 'Unlabeled show') === row.name)
        .map((r) => ({ name: r.entity ?? 'Unassigned', spend: num(r.spend) }))
        .sort((a, b) => b.spend - a.spend),
    })),
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

// Full breakdown of a single trade show, across its whole history — a show is
// a bounded thing, so unlike /summary this takes no date range: clicking a
// show must never surface half a show because a range preset was active.
router.get('/event-breakdown', asyncHandler(async (req, res) => {
  const { event } = req.query as Record<string, string | undefined>;
  if (!event?.trim()) throw createError('event is required', 400, 'INVALID_EVENT');

  const scope = and(
    eq(expenses.expenseKind, 'business'),
    not(inArray(expenses.status, ['draft', 'rejected'])),
    scopeCondition('event'),
    eq(expenses.sourceLabel, event),
  );
  const num = (v: unknown) => Number(v ?? 0);

  const rows = await db.query.expenses.findMany({
    where: scope,
    with: {
      category: { columns: { id: true, name: true } },
      paymentMethod: { columns: { label: true, lastFour: true } },
      user: { columns: { name: true } },
    },
    columns: {
      id: true, date: true, merchant: true, description: true, amount: true,
      status: true, integrationStatus: true, reimbursementStatus: true,
      zohoEntity: true, categoryId: true,
    },
    orderBy: (e, { asc }) => [asc(e.date)],
    limit: 1000,
  });

  const allCats = await db.query.expenseCategories.findMany({
    columns: { id: true, parentId: true, isActive: true, name: true },
  });
  const catNameOf = (id: string) => allCats.find((c) => c.id === id)?.name ?? 'Unknown';
  // Roll spend up to top-level categories so the matrix stays readable —
  // same helper (and cycle safety) the summary report's category chart uses.
  const topCatNameOf = (id: string) => catNameOf(topLevelAncestorId(allCats, id));

  const entityTotals = new Map<string, { spend: number; count: number }>();
  const matrix = new Map<string, Map<string, number>>();
  let total = 0;
  let approved = 0;
  let pending = 0;
  for (const e of rows) {
    const amt = num(e.amount);
    total += amt;
    if (e.status === 'approved' || e.status === 'zoho_sync_failed') approved += 1;
    else pending += 1;
    const entity = e.zohoEntity ?? 'Unassigned';
    const et = entityTotals.get(entity) ?? { spend: 0, count: 0 };
    et.spend += amt;
    et.count += 1;
    entityTotals.set(entity, et);
    const cat = e.categoryId ? topCatNameOf(e.categoryId) : 'Uncategorized';
    const catRow = matrix.get(cat) ?? new Map<string, number>();
    catRow.set(entity, (catRow.get(entity) ?? 0) + amt);
    matrix.set(cat, catRow);
  }

  const entities = [...entityTotals.entries()]
    .map(([name, v]) => ({ name, spend: v.spend, count: v.count }))
    .sort((a, b) => b.spend - a.spend);

  const categories = [...matrix.entries()]
    .map(([category, cells]) => ({
      category,
      byEntity: Object.fromEntries(cells),
      total: [...cells.values()].reduce((s, v) => s + v, 0),
    }))
    .sort((a, b) => b.total - a.total);

  res.json({
    event,
    totals: { spend: total, count: rows.length, approved, pending },
    byEntity: entities,
    categories,
    expenses: rows.map((e) => ({
      id: e.id,
      date: e.date,
      merchant: e.merchant,
      description: e.description,
      amount: num(e.amount),
      status: e.integrationStatus === 'failed' && e.status === 'approved' ? 'zoho_sync_failed' : e.status,
      reimbursementStatus: e.reimbursementStatus,
      zohoEntity: e.zohoEntity,
      categoryName: e.categoryId ? catNameOf(e.categoryId) : null,
      paymentMethod: e.paymentMethod ? `${e.paymentMethod.label}${e.paymentMethod.lastFour ? ` ···${e.paymentMethod.lastFour}` : ''}` : null,
      userName: e.user?.name ?? null,
    })),
  });
}));

export default router;
