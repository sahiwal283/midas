import { Router } from 'express';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db/index';
import { expenses, expenseCategories, paymentMethods } from '../db/schema';
import { authenticate } from '../middleware/auth';
import { asyncHandler, notFound, forbidden, createError } from '../middleware/error';
import { auditLog } from '../lib/audit';
import { storage } from '../lib/storage';
import { canSessionDeleteExpense } from '../lib/expenseDelete';
import { nextReimbursementOnCardLink } from '../lib/reimbursement';
import { evaluateZohoReadiness } from '../lib/zohoReadiness';
import { isAutoPushEligible } from '../lib/autoApprove';
import { pushExpenseToZoho } from '../lib/zohoPush';

const router = Router();

router.use(authenticate);

const createExpenseSchema = z.object({
  merchant: z.string().min(1),
  amount: z.coerce.number().positive(),
  currency: z.string().length(3).default('USD'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  categoryId: z.string().uuid().optional(),
  paymentMethodId: z.string().uuid().optional(),
  description: z.string().optional(),
  /** Accounting entity / Zoho Books org label (e.g. "Haute Brands"). */
  zohoEntity: z.string().min(1).optional(),
  /** Live Zoho expense COA account_id for this entity. */
  zohoExpenseAccountId: z.string().min(1).optional(),
  zohoExpenseAccountName: z.string().min(1).optional(),
});

const updateExpenseSchema = createExpenseSchema.partial();

// List own expenses (or all for accountant/admin)
router.get('/', asyncHandler(async (req, res) => {
  const isPrivileged = req.user!.role === 'accountant' || req.user!.role === 'admin';
  const { status, categoryId } = req.query as Record<string, string>;

  const conditions = [];
  if (!isPrivileged) conditions.push(eq(expenses.userId, req.user!.id));
  if (status) conditions.push(eq(expenses.status, status as typeof expenses.status.enumValues[number]));
  if (categoryId) conditions.push(eq(expenses.categoryId, categoryId));

  const rows = await db.query.expenses.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    with: {
      user: { columns: { id: true, name: true, email: true } },
      category: { columns: { id: true, name: true } },
      paymentMethod: { columns: { id: true, label: true, lastFour: true, brand: true } },
      receipts: { columns: { id: true, filename: true, mimeType: true, ocrStatus: true, uploadedAt: true } },
    },
    orderBy: [desc(expenses.createdAt)],
  });

  res.json({ expenses: rows });
}));

// Get single expense
router.get('/:id', asyncHandler(async (req, res) => {
  const expense = await db.query.expenses.findFirst({
    where: eq(expenses.id, req.params.id),
    with: {
      user: { columns: { id: true, name: true, email: true } },
      reviewedBy: { columns: { id: true, name: true, email: true } },
      category: true,
      paymentMethod: true,
      receipts: true,
      messages: {
        with: { sender: { columns: { id: true, name: true, role: true } } },
        orderBy: (m, { asc }) => [asc(m.createdAt)],
      },
    },
  });

  if (!expense) throw notFound('Expense not found');

  const isOwner = expense.userId === req.user!.id;
  const isPrivileged = req.user!.role === 'accountant' || req.user!.role === 'admin';
  if (!isOwner && !isPrivileged) throw forbidden();

  // Strip accountant-only fields from responses for regular users.
  const safeExpense = isPrivileged
    ? expense
    : {
        ...expense,
        zohoSyncError: null,
        messages: expense.messages?.map((m) => ({ ...m, internalNote: null })),
      };

  res.json({ expense: safeExpense });
}));

// Create draft expense
router.post('/', asyncHandler(async (req, res) => {
  const body = createExpenseSchema.parse(req.body);

  let reimbursementStatus: 'not_requested' | 'pending' = 'not_requested';
  let zohoEntity = body.zohoEntity ?? null;
  if (body.paymentMethodId) {
    const pm = await db.query.paymentMethods.findFirst({
      where: eq(paymentMethods.id, body.paymentMethodId),
    });
    const next = nextReimbursementOnCardLink('not_requested', pm);
    if (next === 'pending') reimbursementStatus = 'pending';
    if (!zohoEntity && pm?.defaultZohoEntity) zohoEntity = pm.defaultZohoEntity;
  }

  if (body.zohoExpenseAccountId && !zohoEntity) {
    throw createError('zohoEntity is required when selecting a Zoho expense account', 400, 'MISSING_ZOHO_ENTITY');
  }

  const [expense] = await db.insert(expenses).values({
    userId: req.user!.id,
    merchant: body.merchant,
    amount: String(body.amount),
    currency: body.currency,
    date: body.date,
    categoryId: body.categoryId ?? null,
    paymentMethodId: body.paymentMethodId ?? null,
    description: body.description,
    zohoEntity,
    zohoExpenseAccountId: body.zohoExpenseAccountId ?? null,
    zohoExpenseAccountName: body.zohoExpenseAccountName ?? null,
    status: 'draft',
    reimbursementStatus,
  }).returning();

  await auditLog({ entityType: 'expense', entityId: expense.id, userId: req.user!.id, action: 'created', after: expense });

  res.status(201).json({ expense });
}));

// Update draft expense
router.patch('/:id', asyncHandler(async (req, res) => {
  const expense = await db.query.expenses.findFirst({ where: eq(expenses.id, req.params.id) });
  if (!expense) throw notFound('Expense not found');
  if (expense.userId !== req.user!.id) throw forbidden();
  if (expense.status !== 'draft') {
    res.status(409).json({ error: { code: 'CONFLICT', message: 'Only draft expenses can be edited' } });
    return;
  }

  const body = updateExpenseSchema.parse(req.body);
  const before = { ...expense };

  let reimbursementPatch: { reimbursementStatus?: 'pending' } = {};
  if (body.paymentMethodId) {
    const pm = await db.query.paymentMethods.findFirst({
      where: eq(paymentMethods.id, body.paymentMethodId),
    });
    const next = nextReimbursementOnCardLink(expense.reimbursementStatus, pm);
    if (next === 'pending') reimbursementPatch = { reimbursementStatus: 'pending' };
  }

  const [updated] = await db.update(expenses)
    .set({
      ...body,
      ...reimbursementPatch,
      amount: body.amount !== undefined ? String(body.amount) : undefined,
      updatedAt: new Date(),
    })
    .where(eq(expenses.id, req.params.id))
    .returning();

  await auditLog({ entityType: 'expense', entityId: expense.id, userId: req.user!.id, action: 'updated', before, after: updated });

  res.json({ expense: updated });
}));

// Submit draft for review
router.post('/:id/submit', asyncHandler(async (req, res) => {
  const expense = await db.query.expenses.findFirst({
    where: eq(expenses.id, req.params.id),
    with: {
      receipts: true,
      category: { columns: { id: true, name: true, zohoAccountId: true } },
      paymentMethod: { columns: { id: true, label: true, zohoAccountName: true } },
      messages: { columns: { requestType: true, isResolved: true } },
    },
  });
  if (!expense) throw notFound('Expense not found');
  if (expense.userId !== req.user!.id) throw forbidden();
  if (expense.status !== 'draft') {
    res.status(409).json({ error: { code: 'CONFLICT', message: 'Expense is not in draft status' } });
    return;
  }

  // Daily auto-push: complete staff-entered expenses skip accountant approval.
  // Readiness is evaluated as-if approved ("ready once approved"). Event
  // expenses (trade_show etc.) and incomplete ones fall through to pending.
  const readiness = evaluateZohoReadiness({ ...expense, status: 'approved' });
  if (isAutoPushEligible({ sourceApp: expense.sourceApp, ready: readiness.ready })) {
    const [approved] = await db.update(expenses)
      .set({ status: 'approved', updatedAt: new Date() })
      .where(eq(expenses.id, expense.id))
      .returning();
    await auditLog({
      entityType: 'expense',
      entityId: expense.id,
      userId: req.user!.id,
      action: 'auto_approved',
      before: { status: 'draft' },
      after: { status: 'approved' },
      metadata: { reason: 'complete daily expense', zohoMode: readiness.zohoMode },
    });

    const outcome = await pushExpenseToZoho({ ...expense, ...approved }, req.user!.id);
    // Push failure → zoho_sync_failed (set by the lib) lands in the accountant
    // retry lane; the submitter's part is done either way.
    res.json({
      expense: outcome.ok ? outcome.expense : { ...approved, status: 'zoho_sync_failed' },
      autoPushed: outcome.ok,
    });
    return;
  }

  const [updated] = await db.update(expenses)
    .set({ status: 'pending', updatedAt: new Date() })
    .where(eq(expenses.id, req.params.id))
    .returning();

  await auditLog({ entityType: 'expense', entityId: expense.id, userId: req.user!.id, action: 'submitted', before: { status: 'draft' }, after: { status: 'pending' } });

  res.json({ expense: updated });
}));

const bulkDeleteSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  force: z.boolean().optional(),
});

async function deleteExpenseRecord(
  expenseId: string,
  actor: { id: string; role: string },
  force: boolean,
): Promise<{ ok: true } | { ok: false; status: 403 | 404 | 409; code: string; message: string }> {
  const expense = await db.query.expenses.findFirst({
    where: eq(expenses.id, expenseId),
    with: { receipts: true },
  });
  if (!expense) {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Expense not found' };
  }

  const decision = canSessionDeleteExpense({
    role: actor.role,
    actorUserId: actor.id,
    expense,
    force,
  });
  if (!decision.ok) {
    return { ok: false, status: decision.status, code: decision.code, message: decision.message };
  }

  for (const r of expense.receipts) {
    await storage.delete(r.storagePath);
  }
  await db.delete(expenses).where(eq(expenses.id, expense.id));
  await auditLog({
    entityType: 'expense',
    entityId: expense.id,
    userId: actor.id,
    action: 'deleted',
    before: {
      status: expense.status,
      zohoExpenseId: expense.zohoExpenseId,
      sourceApp: expense.sourceApp,
      force: force || undefined,
    },
  });
  return { ok: true };
}

// Bulk delete (accountant/admin cleanup + owner drafts)
router.post('/bulk-delete', asyncHandler(async (req, res) => {
  const body = bulkDeleteSchema.parse(req.body);
  const force = body.force === true;
  const actor = { id: req.user!.id, role: req.user!.role };

  const deleted: string[] = [];
  const failed: Array<{ id: string; code: string; message: string }> = [];

  for (const id of body.ids) {
    const result = await deleteExpenseRecord(id, actor, force);
    if (result.ok) deleted.push(id);
    else failed.push({ id, code: result.code, message: result.message });
  }

  res.json({ deleted, failed });
}));

// Delete expense (owner draft/pending; accountant/admin any without Zoho; admin+force with Zoho)
router.delete('/:id', asyncHandler(async (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true';
  const result = await deleteExpenseRecord(req.params.id, { id: req.user!.id, role: req.user!.role }, force);
  if (!result.ok) {
    if (result.status === 404) throw notFound(result.message);
    if (result.status === 403) throw forbidden();
    throw createError(result.message, result.status, result.code);
  }
  res.json({ ok: true });
}));

// Categories (read-only for all users)
router.get('/categories/list', asyncHandler(async (_req, res) => {
  const cats = await db.query.expenseCategories.findMany({
    where: eq(expenseCategories.isActive, true),
    orderBy: (c, { asc }) => [asc(c.name)],
  });
  res.json({ categories: cats });
}));

export default router;
