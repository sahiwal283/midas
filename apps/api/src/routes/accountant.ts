import { Router } from 'express';
import { z } from 'zod';
import { eq, and, or, inArray, desc, isNotNull, isNull, ilike, gte, lte, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { expenses, expenseMessages, expenseStatusEnum, auditLogs, users, closedPeriods, transactions } from '../db/schema';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler, notFound, forbidden, createError } from '../middleware/error';
import { auditLog } from '../lib/audit';
import { PERIOD_RE, isInClosedPeriods, periodOf, closedPeriodMessage } from '../lib/closedPeriods';
import { getClosedPeriods } from '../lib/closedPeriodsDb';
import { roleAllowed } from '../lib/roles';
import { pushExpenseToZoho } from '../lib/zohoPush';
import { parseQueueFilters, partitionBulkReview } from '../lib/queueFilters';
import { computeFlags } from '../lib/flags';
import { nextReimbursementOnCardLink } from '../lib/reimbursement';
import { notifyUser } from '../lib/notify';
import { syncExpenseToTransaction } from '../lib/syncExpenseTransaction';
import { pushPurchaseOrderToZoho } from '../lib/zohoPoPush';
import { assertActiveCompany } from '../lib/companies';

const router = Router();
router.use(authenticate, requireRole('accountant', 'admin'));

const REQUEST_TYPES = ['info_request', 'missing_receipt', 'missing_category', 'missing_payment_method', 'general'] as const;

const reviewSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('approve'),
    note: z.string().optional(),
    zohoEntity: z.string().optional(),
  }),
  z.object({
    action: z.literal('reject'),
    note: z.string().optional(),
  }),
  z.object({
    action: z.literal('request_info'),
    note: z.string().min(1, 'Explain what information is needed'),
    requestType: z.enum(REQUEST_TYPES).default('info_request'),
    internalNote: z.string().optional(),
  }),
]);

const reimbursementSchema = z.object({
  status: z.enum(['not_requested', 'pending', 'approved', 'rejected', 'paid']),
  note: z.string().optional(),
});

type StatusValue = (typeof expenseStatusEnum.enumValues)[number];

const QUEUE_STATUSES: StatusValue[] = ['pending', 'in_review', 'awaiting_info', 'approved'];

// ── Queue ─────────────────────────────────────────────────────────────────────

router.get('/queue', asyncHandler(async (req, res) => {
  const f = parseQueueFilters(req.query as Record<string, string | undefined>);
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));
  const queueStatuses: StatusValue[] = f.status === 'zoho_sync_failed'
    ? ['approved']
    : f.status === 'needs_review'
      ? ['pending', 'in_review']
      : f.status && (expenseStatusEnum.enumValues as readonly string[]).includes(f.status)
        ? [f.status as StatusValue]
        : QUEUE_STATUSES;

  // Partner spend is tracked on its own tab and never enters review.
  const conds = [
    inArray(expenses.status, queueStatuses),
    eq(expenses.expenseKind, 'business'),
  ];
  if (f.status === 'zoho_sync_failed') conds.push(eq(expenses.integrationStatus, 'failed'));
  if (f.userId) conds.push(eq(expenses.userId, f.userId));
  if (f.search) {
    conds.push(or(
      ilike(expenses.merchant, `%${f.search}%`),
      ilike(expenses.description, `%${f.search}%`),
    )!);
  }
  if (f.amountMin !== undefined) conds.push(gte(expenses.amount, String(f.amountMin)));
  if (f.amountMax !== undefined) conds.push(lte(expenses.amount, String(f.amountMax)));
  if (f.from) conds.push(gte(expenses.date, f.from));
  if (f.to) conds.push(lte(expenses.date, f.to));
  if (f.categoryId) conds.push(eq(expenses.categoryId, f.categoryId));
  if (f.paymentMethodId) conds.push(eq(expenses.paymentMethodId, f.paymentMethodId));
  if (f.reimbursementStatus) conds.push(sql`${expenses.reimbursementStatus} = ${f.reimbursementStatus}`);
  if (f.company) conds.push(eq(expenses.zohoEntity, f.company));
  if (f.sourceApp) conds.push(eq(expenses.sourceApp, f.sourceApp));
  if (f.zohoStatus === 'synced') conds.push(eq(expenses.integrationStatus, 'synced'));
  if (f.zohoStatus === 'not_synced') conds.push(sql`${expenses.integrationStatus} <> 'synced'`);
  if (f.zohoStatus === 'sync_failed') conds.push(eq(expenses.integrationStatus, 'failed'));
  if (f.missingReceipt) conds.push(sql`not exists (select 1 from receipts r where r.expense_id = ${expenses.id})`);
  if (f.ocrNeedsReview) conds.push(sql`exists (select 1 from receipts r where r.expense_id = ${expenses.id} and r.ocr_needs_review = true)`);
  if (f.missingCategory) conds.push(and(isNull(expenses.categoryId), isNull(expenses.zohoExpenseAccountId))!);
  if (f.missingPayment) conds.push(isNull(expenses.paymentMethodId));
  if (f.transactionType === 'expense' || f.transactionType === 'purchase_order') {
    if (f.transactionType === 'purchase_order') {
      res.json({ expenses: [], page, pageSize, total: 0, totalPages: 0 });
      return;
    }
  }

  const where = and(...conds);
  const [{ n: total }] = await db.select({ n: sql<number>`count(*)::int` }).from(expenses).where(where);

  const rows = await db.query.expenses.findMany({
    where,
    with: {
      user: { columns: { id: true, name: true, email: true } },
      reviewedBy: { columns: { id: true, name: true, email: true } },
      category: { columns: { id: true, name: true } },
      paymentMethod: { columns: { id: true, label: true, lastFour: true, brand: true, requiresReimbursement: true } },
      receipts: { columns: { id: true, ocrStatus: true, ocrNeedsReview: true } },
    },
    orderBy: [desc(expenses.createdAt)],
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  const expensesWithFlags = rows.map((row) => {
    const flags = computeFlags(row);
    const wireStatus = row.integrationStatus === 'failed' && row.status === 'approved'
      ? 'zoho_sync_failed'
      : row.status;
    return { ...row, status: wireStatus, flags, zohoReady: flags.includes('ready_for_zoho') };
  });
  res.json({
    expenses: expensesWithFlags,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
}));

/** Purchase-order review queue (transaction type filter). */
router.get('/purchase-orders', asyncHandler(async (_req, res) => {
  const rows = await db.query.transactions.findMany({
    where: and(
      eq(transactions.type, 'purchase_order'),
      inArray(transactions.status, ['submitted', 'in_review', 'awaiting_info', 'approved']),
    ),
    with: {
      user: { columns: { id: true, name: true, email: true } },
      purchaseOrder: true,
      lineItems: true,
    },
    orderBy: [desc(transactions.createdAt)],
  });
  res.json({
    purchaseOrders: rows.map((r) => ({
      ...r,
      lineItemCount: r.lineItems?.length ?? 0,
      poNumber: r.purchaseOrder?.poNumber ?? null,
    })),
  });
}));

router.post('/purchase-orders/:id/zoho-push', asyncHandler(async (req, res) => {
  const outcome = await pushPurchaseOrderToZoho(req.params.id, req.user!.id);
  if (outcome.ok) {
    res.json({ transaction: outcome.transaction, zoho: outcome.zoho });
    return;
  }
  if (outcome.status === 409) throw createError(outcome.message, 409, outcome.code);
  res.status(502).json({
    error: { code: outcome.code, message: outcome.message, requestId: outcome.requestId },
  });
}));

router.get('/queue/summary', asyncHandler(async (_req, res) => {
  const rows = await db.query.expenses.findMany({
    where: and(inArray(expenses.status, QUEUE_STATUSES), eq(expenses.expenseKind, 'business')),
    with: {
      receipts: { columns: { id: true } },
    },
    columns: {
      status: true,
      integrationStatus: true,
      categoryId: true,
      paymentMethodId: true,
      zohoEntity: true,
      zohoExpenseId: true,
      reimbursementStatus: true,
      sourceApp: true,
      amount: true,
      userId: true,
      zohoExpenseAccountId: true,
    },
  });

  const counts: Record<string, number> = {
    pending: 0,
    in_review: 0,
    awaiting_info: 0,
    zoho_sync_failed: 0,
    approved: 0,
    needs_category: 0,
    missing_receipt: 0,
    needs_payment_method: 0,
    needs_entity: 0,
    ready_for_zoho: 0,
    reimbursement_pending: 0,
  };

  let readyForZohoAmount = 0;
  let reimbursementPendingAmount = 0;
  const reimbursementEmployeeIds = new Set<string>();

  for (const row of rows) {
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

  res.json({
    counts,
    readyForZohoAmount,
    reimbursementPendingAmount,
    reimbursementEmployees: reimbursementEmployeeIds.size,
  });
}));

router.get('/expenses', asyncHandler(async (_req, res) => {
  const rows = await db.query.expenses.findMany({
    // Partner spend is tracked on its own tab and never enters review.
    where: eq(expenses.expenseKind, 'business'),
    with: {
      user: { columns: { id: true, name: true, email: true } },
      reviewedBy: { columns: { id: true, name: true, email: true } },
      category: { columns: { id: true, name: true } },
      paymentMethod: { columns: { id: true, label: true, lastFour: true, brand: true, requiresReimbursement: true } },
      receipts: { columns: { id: true, ocrStatus: true, ocrNeedsReview: true } },
    },
    orderBy: [desc(expenses.createdAt)],
  });
  const expensesWithFlags = rows.map((row) => {
    const flags = computeFlags(row);
    return { ...row, flags, zohoReady: flags.includes('ready_for_zoho') };
  });
  res.json({ expenses: expensesWithFlags });
}));

// Employees with expenses in the queue — powers the employee filter.
router.get('/employees', asyncHandler(async (_req, res) => {
  const rows = await db.selectDistinct({ id: users.id, name: users.name })
    .from(expenses)
    .innerJoin(users, eq(expenses.userId, users.id))
    .where(and(inArray(expenses.status, QUEUE_STATUSES), eq(expenses.expenseKind, 'business')));
  res.json({ employees: rows.sort((a, b) => a.name.localeCompare(b.name)) });
}));

// ── Bulk review (safe bulk approval) ─────────────────────────────────────────
// Approves only pending/in_review; everything else is skipped with a reason.
// The UI is responsible for showing the flagged summary BEFORE calling this.

const bulkReviewSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  action: z.literal('approve'),
});

router.post('/expenses/bulk-review', asyncHandler(async (req, res) => {
  const { ids } = bulkReviewSchema.parse(req.body);

  const rows = await db.query.expenses.findMany({
    where: inArray(expenses.id, ids),
    with: { paymentMethod: true },
  });
  const { approvable, skipped } = partitionBulkReview(rows, ids);

  const approved: string[] = [];
  const now = new Date();
  const closed = await getClosedPeriods();
  for (const id of approvable) {
    const expense = rows.find((r) => r.id === id)!;
    if (isInClosedPeriods(expense.date, closed)) {
      skipped.push({ id, reason: closedPeriodMessage(periodOf(expense.date)) });
      continue;
    }
    let reimbursementStatus = expense.reimbursementStatus;
    const next = nextReimbursementOnCardLink(expense.reimbursementStatus, expense.paymentMethod);
    if (next) reimbursementStatus = next as typeof expense.reimbursementStatus;

    await db.update(expenses)
      .set({
        status: 'approved',
        integrationStatus: expense.zohoEntity ? 'pending' : 'not_required',
        reviewedById: req.user!.id,
        reviewedAt: now,
        reimbursementStatus,
        updatedAt: now,
      })
      .where(eq(expenses.id, id));
    const after = await db.query.expenses.findFirst({ where: eq(expenses.id, id) });
    if (after) await syncExpenseToTransaction(after);
    await auditLog({
      entityType: 'expense',
      entityId: id,
      userId: req.user!.id,
      action: 'review.approve',
      before: { status: expense.status },
      after: { status: 'approved' },
      metadata: { bulk: true },
    });
    approved.push(id);

    // Notify the owner — never the acting accountant about their own expense.
    if (expense.userId !== req.user!.id) {
      await notifyUser(expense.userId, 'approved', {
        expenseId: id,
        merchant: expense.merchant,
        amount: expense.amount,
      });
    }
  }

  res.json({ approved, skipped });
}));

// ── Bulk Zoho push ────────────────────────────────────────────────────────────

const bulkPushSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) });

router.post('/zoho/bulk-push', asyncHandler(async (req, res) => {
  const { ids } = bulkPushSchema.parse(req.body);

  const pushed: string[] = [];
  const failed: Array<{ id: string; code: string; message: string }> = [];

  for (const id of ids) {
    const expense = await db.query.expenses.findFirst({
      where: eq(expenses.id, id),
      with: {
        receipts: { columns: { id: true } },
        category: { columns: { id: true, name: true, zohoAccountId: true } },
        paymentMethod: { columns: { id: true, label: true, zohoAccountName: true } },
      },
    });
    if (!expense) {
      failed.push({ id, code: 'NOT_FOUND', message: 'Expense not found' });
      continue;
    }
    if (expense.status !== 'approved' || (expense.integrationStatus !== 'pending' && expense.integrationStatus !== 'failed' && expense.integrationStatus !== 'queued')) {
      // Allow legacy rows still on zoho_sync_failed status if any remain
      if (expense.status !== 'zoho_sync_failed' && expense.integrationStatus !== 'failed') {
        failed.push({ id, code: 'CONFLICT', message: `Not pushable from status '${expense.status}' / integration '${expense.integrationStatus}'` });
        continue;
      }
    }
    const outcome = await pushExpenseToZoho(expense, req.user!.id);
    if (outcome.ok) pushed.push(id);
    else failed.push({ id, code: outcome.code, message: outcome.message });
  }

  res.json({ pushed, failed });
}));

// ── Review ────────────────────────────────────────────────────────────────────

router.patch('/expenses/:id/review', asyncHandler(async (req, res) => {
  const expense = await db.query.expenses.findFirst({
    where: eq(expenses.id, req.params.id),
    with: { paymentMethod: true },
  });
  if (!expense) throw notFound('Expense not found');

  // Partner spend never enters review — it is recorded final on submit.
  if (expense.expenseKind === 'partner') {
    throw createError('Partner expenses are not reviewable', 409, 'CONFLICT');
  }

  const parsed = reviewSchema.parse(req.body);
  const { action } = parsed;
  const before = { status: expense.status, reimbursementStatus: expense.reimbursementStatus };

  const reviewable: StatusValue[] = ['pending', 'in_review', 'awaiting_info'];
  if (!reviewable.includes(expense.status as StatusValue)) {
    throw createError(
      `Expense cannot be reviewed from status '${expense.status}'`,
      409,
      'CONFLICT',
    );
  }

  const closed = await getClosedPeriods();
  if (isInClosedPeriods(expense.date, closed)) {
    throw createError(closedPeriodMessage(periodOf(expense.date)), 409, 'PERIOD_CLOSED');
  }

  const newStatus: StatusValue = action === 'approve' ? 'approved'
    : action === 'reject' ? 'rejected'
    : 'awaiting_info';

  // Personal cards: ensure reimbursement workflow is started on approve
  let reimbursementStatus = expense.reimbursementStatus;
  if (action === 'approve') {
    const next = nextReimbursementOnCardLink(expense.reimbursementStatus, expense.paymentMethod);
    if (next) reimbursementStatus = next as typeof expense.reimbursementStatus;
  }

  const now = new Date();
  const [updated] = await db.update(expenses)
    .set({
      status: newStatus,
      integrationStatus: action === 'approve'
        ? ((('zohoEntity' in parsed && parsed.zohoEntity) || expense.zohoEntity) ? 'pending' : 'not_required')
        : expense.integrationStatus,
      reviewedById: req.user!.id,
      reviewedAt: now,
      reimbursementStatus,
      updatedAt: now,
      ...(action === 'approve' && 'zohoEntity' in parsed && parsed.zohoEntity
        ? { zohoEntity: parsed.zohoEntity } : {}),
    })
    .where(eq(expenses.id, req.params.id))
    .returning();

  await syncExpenseToTransaction(updated);

  if (action === 'request_info') {
    await db.insert(expenseMessages).values({
      expenseId: expense.id,
      senderId: req.user!.id,
      body: parsed.note,
      isSystem: false,
      requestType: parsed.requestType,
      internalNote: parsed.internalNote ?? null,
      isResolved: false,
    });
  } else if ('note' in parsed && parsed.note) {
    await db.insert(expenseMessages).values({
      expenseId: expense.id,
      senderId: req.user!.id,
      body: parsed.note,
      isSystem: true,
    });
  }

  await auditLog({
    entityType: 'expense',
    entityId: expense.id,
    userId: req.user!.id,
    action: `review.${action}`,
    before,
    after: { status: newStatus },
    metadata: action === 'request_info'
      ? { requestType: parsed.requestType, hasNote: true }
      : 'note' in parsed && parsed.note ? { note: parsed.note } : undefined,
  });

  // Notify the owner — never the actor about their own action.
  if (expense.userId !== req.user!.id) {
    const notifType = action === 'approve' ? 'approved'
      : action === 'reject' ? 'rejected'
      : 'action_required';
    await notifyUser(expense.userId, notifType, {
      expenseId: expense.id,
      merchant: expense.merchant,
      amount: expense.amount,
      ...(action === 'reject' && parsed.note ? { note: parsed.note } : {}),
    });
  }

  res.json({ expense: updated });
}));

// Accountant closes an open info request (without waiting for user)
router.post('/expenses/:id/resolve-request', asyncHandler(async (req, res) => {
  const expense = await db.query.expenses.findFirst({ where: eq(expenses.id, req.params.id) });
  if (!expense) throw notFound('Expense not found');

  const openRequests = await db.query.expenseMessages.findMany({
    where: and(
      eq(expenseMessages.expenseId, req.params.id),
      isNotNull(expenseMessages.requestType),
      eq(expenseMessages.isResolved, false),
    ),
    columns: { id: true },
  });

  for (const msg of openRequests) {
    await db.update(expenseMessages)
      .set({ isResolved: true, resolvedAt: new Date(), resolvedById: req.user!.id })
      .where(and(
        eq(expenseMessages.id, msg.id),
        eq(expenseMessages.isResolved, false),
      ));
  }

  if (expense.status === 'awaiting_info') {
    await db.update(expenses)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(eq(expenses.id, req.params.id));

    await auditLog({
      entityType: 'expense',
      entityId: expense.id,
      userId: req.user!.id,
      action: 'info_request_resolved',
      before: { status: 'awaiting_info' },
      after: { status: 'pending' },
    });
  }

  res.json({ ok: true, resolvedCount: openRequests.length });
}));

// ── Reimbursement ─────────────────────────────────────────────────────────────

router.patch('/expenses/:id/reimbursement', asyncHandler(async (req, res) => {
  const expense = await db.query.expenses.findFirst({ where: eq(expenses.id, req.params.id) });
  if (!expense) throw notFound('Expense not found');

  const closed = await getClosedPeriods();
  if (isInClosedPeriods(expense.date, closed)) {
    throw createError(closedPeriodMessage(periodOf(expense.date)), 409, 'PERIOD_CLOSED');
  }

  const { status, note } = reimbursementSchema.parse(req.body);
  const before = { reimbursementStatus: expense.reimbursementStatus };

  const [updated] = await db.update(expenses)
    .set({ reimbursementStatus: status, updatedAt: new Date() })
    .where(eq(expenses.id, req.params.id))
    .returning();

  if (note) {
    await db.insert(expenseMessages).values({
      expenseId: expense.id,
      senderId: req.user!.id,
      body: note,
      isSystem: true,
    });
  }

  await auditLog({
    entityType: 'expense',
    entityId: expense.id,
    userId: req.user!.id,
    action: 'reimbursement.updated',
    before,
    after: { reimbursementStatus: status },
  });

  // Owner is told when their reimbursement lands — never the acting accountant.
  if (status === 'paid' && expense.reimbursementStatus !== 'paid' && expense.userId !== req.user!.id) {
    await notifyUser(expense.userId, 'reimbursement_paid', {
      expenseId: expense.id,
      merchant: expense.merchant,
      amount: expense.amount,
    });
  }

  res.json({ expense: updated });
}));

// ── Zoho push ─────────────────────────────────────────────────────────────────

router.post('/expenses/:id/zoho-push', asyncHandler(async (req, res) => {
  const expense = await db.query.expenses.findFirst({
    where: eq(expenses.id, req.params.id),
    with: {
      receipts: { columns: { id: true } },
      category: { columns: { id: true, name: true, zohoAccountId: true } },
      paymentMethod: { columns: { id: true, label: true, zohoAccountName: true } },
    },
  });
  if (!expense) throw notFound('Expense not found');

  if (
    expense.status !== 'approved'
    && expense.status !== 'zoho_sync_failed'
    && expense.integrationStatus !== 'failed'
  ) {
    throw createError('Only approved or sync-failed expenses can be pushed to Zoho', 409, 'CONFLICT');
  }
  const outcome = await pushExpenseToZoho(expense, req.user!.id);
  if (outcome.ok) {
    res.json({ expense: outcome.expense, zoho: outcome.zoho });
    return;
  }
  if (outcome.status === 409) throw createError(outcome.message, 409, outcome.code);
  res.status(502).json({
    error: {
      code: outcome.code,
      message: outcome.message,
      requestId: outcome.requestId,
    },
  });
}));

// ── Closed accounting periods ─────────────────────────────────────────────────
// Closing a month ('YYYY-MM') locks every expense dated in it. Reopen (DELETE)
// is admin-only — the router-level gate admits accountants, so re-check here.

router.get('/closed-periods', asyncHandler(async (_req, res) => {
  const rows = await db.query.closedPeriods.findMany({
    with: { closedBy: { columns: { id: true, name: true } } },
    orderBy: [desc(closedPeriods.period)],
  });
  res.json({ closedPeriods: rows });
}));

const closePeriodSchema = z.object({
  period: z.string().regex(PERIOD_RE, 'period must be YYYY-MM'),
  note: z.string().max(500).optional(),
});

router.post('/closed-periods', asyncHandler(async (req, res) => {
  const { period, note } = closePeriodSchema.parse(req.body);

  const existing = await db.query.closedPeriods.findFirst({ where: eq(closedPeriods.period, period) });
  if (existing) {
    throw createError(`Period ${period} is already closed`, 409, 'ALREADY_CLOSED');
  }

  const [row] = await db.insert(closedPeriods)
    .values({ period, note: note ?? null, closedById: req.user!.id })
    .returning();

  await auditLog({
    entityType: 'closed_period',
    entityId: period,
    userId: req.user!.id,
    action: 'period.closed',
    after: { period, note: note ?? null },
  });

  res.status(201).json({ closedPeriod: row });
}));

router.delete('/closed-periods/:period', asyncHandler(async (req, res) => {
  // Reopen is admin-only (developer passes every role gate via roleAllowed).
  if (!roleAllowed(req.user!.role, ['admin'])) {
    throw forbidden('Only an admin can reopen a closed period');
  }

  const { period } = req.params;
  const existing = await db.query.closedPeriods.findFirst({ where: eq(closedPeriods.period, period) });
  if (!existing) throw notFound('Period is not closed');

  await db.delete(closedPeriods).where(eq(closedPeriods.period, period));

  await auditLog({
    entityType: 'closed_period',
    entityId: period,
    userId: req.user!.id,
    action: 'period.reopened',
    before: { period, note: existing.note },
  });

  res.json({ ok: true });
}));

// ── Audit trail for an expense ────────────────────────────────────────────────

router.get('/expenses/:id/audit', asyncHandler(async (req, res) => {
  const expense = await db.query.expenses.findFirst({ where: eq(expenses.id, req.params.id), columns: { id: true } });
  if (!expense) throw notFound('Expense not found');

  const rows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      before: auditLogs.before,
      after: auditLogs.after,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
      actorId: auditLogs.userId,
      actorName: users.name,
      actorRole: users.role,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .where(and(eq(auditLogs.entityType, 'expense'), eq(auditLogs.entityId, req.params.id)))
    .orderBy(desc(auditLogs.createdAt))
    .limit(15);

  res.json({ entries: rows });
}));

// ── Set Zoho entity on an approved expense ────────────────────────────────────

router.patch('/expenses/:id/zoho-entity', asyncHandler(async (req, res) => {
  const raw = z.object({ zohoEntity: z.string().min(1) }).parse(req.body);
  const zohoEntity = await assertActiveCompany(raw.zohoEntity);
  if (!zohoEntity) throw createError('zohoEntity is required', 400, 'MISSING_ZOHO_ENTITY');
  const expense = await db.query.expenses.findFirst({ where: eq(expenses.id, req.params.id) });
  if (!expense) throw notFound('Expense not found');

  const [updated] = await db.update(expenses)
    .set({ zohoEntity, updatedAt: new Date() })
    .where(eq(expenses.id, req.params.id))
    .returning();

  await syncExpenseToTransaction(updated!);
  await auditLog({
    entityType: 'expense',
    entityId: expense.id,
    userId: req.user!.id,
    action: 'zoho_entity.set',
    before: { zohoEntity: expense.zohoEntity },
    after: { zohoEntity },
  });

  res.json({ expense: updated });
}));

export default router;
