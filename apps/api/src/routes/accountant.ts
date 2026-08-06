import { Router } from 'express';
import { z } from 'zod';
import { eq, and, inArray, desc, isNotNull } from 'drizzle-orm';
import { db } from '../db/index';
import { expenses, expenseMessages, expenseStatusEnum, auditLogs, users } from '../db/schema';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler, notFound, createError } from '../middleware/error';
import { auditLog } from '../lib/audit';
import { pushExpenseToZoho } from '../lib/zohoPush';
import { computeFlags } from '../lib/flags';
import { nextReimbursementOnCardLink } from '../lib/reimbursement';

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

const QUEUE_STATUSES: StatusValue[] = ['pending', 'in_review', 'awaiting_info', 'zoho_sync_failed', 'approved'];

// ── Queue ─────────────────────────────────────────────────────────────────────

router.get('/queue', asyncHandler(async (req, res) => {
  const { status } = req.query as Record<string, string>;
  const queueStatuses: StatusValue[] = status ? [status as StatusValue] : QUEUE_STATUSES;

  const rows = await db.query.expenses.findMany({
    where: inArray(expenses.status, queueStatuses),
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

router.get('/queue/summary', asyncHandler(async (_req, res) => {
  const rows = await db.query.expenses.findMany({
    where: inArray(expenses.status, QUEUE_STATUSES),
    with: {
      receipts: { columns: { id: true } },
    },
    columns: {
      status: true,
      categoryId: true,
      paymentMethodId: true,
      zohoEntity: true,
      zohoExpenseId: true,
      reimbursementStatus: true,
      sourceApp: true,
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

  for (const row of rows) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
    const flags = computeFlags(row as Parameters<typeof computeFlags>[0]);
    for (const flag of flags) {
      if (flag in counts) counts[flag]++;
    }
  }

  res.json({ counts });
}));

router.get('/expenses', asyncHandler(async (_req, res) => {
  const rows = await db.query.expenses.findMany({
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

// ── Review ────────────────────────────────────────────────────────────────────

router.patch('/expenses/:id/review', asyncHandler(async (req, res) => {
  const expense = await db.query.expenses.findFirst({
    where: eq(expenses.id, req.params.id),
    with: { paymentMethod: true },
  });
  if (!expense) throw notFound('Expense not found');

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
      reviewedById: req.user!.id,
      reviewedAt: now,
      reimbursementStatus,
      updatedAt: now,
      ...(action === 'approve' && 'zohoEntity' in parsed && parsed.zohoEntity
        ? { zohoEntity: parsed.zohoEntity } : {}),
    })
    .where(eq(expenses.id, req.params.id))
    .returning();

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

  if (expense.status !== 'approved' && expense.status !== 'zoho_sync_failed') {
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
  const { zohoEntity } = z.object({ zohoEntity: z.string().min(1) }).parse(req.body);
  const expense = await db.query.expenses.findFirst({ where: eq(expenses.id, req.params.id) });
  if (!expense) throw notFound('Expense not found');

  const [updated] = await db.update(expenses)
    .set({ zohoEntity, updatedAt: new Date() })
    .where(eq(expenses.id, req.params.id))
    .returning();

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
