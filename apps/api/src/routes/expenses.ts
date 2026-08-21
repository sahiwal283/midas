import { Router } from 'express';
import { z } from 'zod';
import { eq, and, or, desc, ilike, gte, lte, count, sql, inArray } from 'drizzle-orm';
import { db } from '../db/index';
import { expenses, expenseCategories, paymentMethods, companies, expenseMessages } from '../db/schema';
import { authenticate } from '../middleware/auth';
import { asyncHandler, notFound, forbidden, createError } from '../middleware/error';
import { auditLog } from '../lib/audit';
import { storage } from '../lib/storage';
import { canSessionDeleteExpense } from '../lib/expenseDelete';
import { isInClosedPeriods, periodOf, closedPeriodMessage } from '../lib/closedPeriods';
import { getClosedPeriods } from '../lib/closedPeriodsDb';
import { roleAllowed } from '../lib/roles';
import { nextReimbursementOnCardLink } from '../lib/reimbursement';
import { evaluateZohoReadiness } from '../lib/zohoReadiness';
import { editableFields, editRefusalMessage } from '../lib/expenseEdit';
import { isLikelyDuplicate } from '../lib/duplicates';
import { isAutoPushEligible } from '../lib/autoApprove';
import { resolveExpenseKind } from '../lib/expenseKind';
import { pushExpenseToZoho } from '../lib/zohoPush';
import { syncExpenseToTransaction, removeSyncedTransaction } from '../lib/syncExpenseTransaction';
import { effectivelyActiveIds, descendantIds } from '../lib/categoryTree';
import { assertActiveCompany } from '../lib/companies';
import { isDailyAutoPushCandidate, incompleteSubmissionMessage } from '../lib/pendingCompletion';
import { maybeAutoPushPending } from '../lib/pendingCompletionDb';
import { notifyUser } from '../lib/notify';

const router = Router();

router.use(authenticate);

const createExpenseSchema = z.object({
  merchant: z.string().min(1).optional(),
  amount: z.coerce.number().positive().optional(),
  currency: z.string().length(3).default('USD'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Wizard flow: create an empty draft before OCR fills the fields. */
  draft: z.boolean().optional(),
  categoryId: z.string().uuid().optional(),
  paymentMethodId: z.string().uuid().optional(),
  description: z.string().optional(),
  /** Accounting entity / Zoho Books org label (e.g. "Haute Brands"). */
  zohoEntity: z.string().min(1).optional(),
  /** Live Zoho expense COA account_id for this entity. */
  zohoExpenseAccountId: z.string().min(1).optional(),
  zohoExpenseAccountName: z.string().min(1).optional(),
  /** Partner-role only; coerced to 'business' for every other role. */
  expenseKind: z.enum(['business', 'partner']).optional(),
});

const updateExpenseSchema = createExpenseSchema.partial();

// List own expenses — for every role. Company-wide browsing lives on the
// accountant endpoints (/accountant/all et al). Optional server-side
// search/date filters and pagination: when `page` is present the response is
// { expenses, total, page, pageSize }; otherwise the legacy full array.
router.get('/', asyncHandler(async (req, res) => {
  const { status, categoryId, search, from, to, page, pageSize } = req.query as Record<string, string>;

  const conditions = [eq(expenses.userId, req.user!.id)];
  if (status) conditions.push(eq(expenses.status, status as typeof expenses.status.enumValues[number]));
  if (categoryId) {
    // A parent category matches itself and all descendants.
    const allCats = await db.query.expenseCategories.findMany({ columns: { id: true, parentId: true, isActive: true } });
    conditions.push(inArray(expenses.categoryId, descendantIds(allCats, categoryId)));
  }
  if (search?.trim()) {
    conditions.push(or(
      ilike(expenses.merchant, `%${search.trim()}%`),
      ilike(expenses.description, `%${search.trim()}%`),
    )!);
  }
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) conditions.push(gte(expenses.date, from));
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) conditions.push(lte(expenses.date, to));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const relations = {
    user: { columns: { id: true, name: true, email: true } },
    category: { columns: { id: true, name: true } },
    paymentMethod: { columns: { id: true, label: true, lastFour: true, brand: true } },
    receipts: { columns: { id: true, filename: true, mimeType: true, ocrStatus: true, uploadedAt: true } },
  } as const;

  if (page !== undefined) {
    const p = Math.max(1, Number(page) || 1);
    const size = Math.min(100, Math.max(1, Number(pageSize) || 50));
    const [rows, [{ n }]] = await Promise.all([
      db.query.expenses.findMany({
        where,
        with: relations,
        orderBy: [desc(expenses.createdAt)],
        limit: size,
        offset: (p - 1) * size,
      }),
      db.select({ n: count() }).from(expenses).where(where ?? sql`true`),
    ]);
    res.json({ expenses: rows, total: Number(n), page: p, pageSize: size });
    return;
  }

  const rows = await db.query.expenses.findMany({
    where,
    with: relations,
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
  const isPrivileged = roleAllowed(req.user!.role, ['accountant', 'admin']);
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

  // Non-draft creates keep the original required fields; the wizard's
  // draft:true path defers them until submit (which re-validates).
  if (!body.draft && (!body.merchant || body.amount === undefined || !body.date)) {
    throw createError('merchant, amount, and date are required', 400, 'VALIDATION_ERROR');
  }

  const expenseKind = resolveExpenseKind(body.expenseKind, req.user!.role);

  let reimbursementStatus: 'not_requested' | 'pending' = 'not_requested';
  let zohoEntity = body.zohoEntity ?? null;
  if (body.paymentMethodId) {
    const pm = await db.query.paymentMethods.findFirst({
      where: eq(paymentMethods.id, body.paymentMethodId),
    });
    // Partner spend never carries a reimbursement liability, even on a
    // reimbursable card — a partner paying personally isn't owed by the company.
    const next = expenseKind === 'partner' ? null : nextReimbursementOnCardLink('not_requested', pm);
    if (next === 'pending') reimbursementStatus = 'pending';
    if (!zohoEntity && pm?.defaultZohoEntity) zohoEntity = pm.defaultZohoEntity;
  }

  if (body.zohoExpenseAccountId && !zohoEntity) {
    throw createError('zohoEntity is required when selecting a Zoho expense account', 400, 'MISSING_ZOHO_ENTITY');
  }

  zohoEntity = await assertActiveCompany(zohoEntity);

  const [expense] = await db.insert(expenses).values({
    userId: req.user!.id,
    merchant: body.merchant ?? '',
    amount: String(body.amount ?? 0),
    currency: body.currency,
    date: body.date ?? new Date().toISOString().slice(0, 10),
    categoryId: body.categoryId ?? null,
    paymentMethodId: body.paymentMethodId ?? null,
    description: body.description,
    zohoEntity,
    zohoExpenseAccountId: body.zohoExpenseAccountId ?? null,
    zohoExpenseAccountName: body.zohoExpenseAccountName ?? null,
    expenseKind,
    status: 'draft',
    reimbursementStatus,
  }).returning();

  await syncExpenseToTransaction(expense);
  await auditLog({ entityType: 'expense', entityId: expense.id, userId: req.user!.id, action: 'created', after: expense });

  res.status(201).json({ expense });
}));

// Update expense — state-based rules (draft/awaiting_info: all fields;
// pending: notes only; synced or reviewed states: locked).
router.patch('/:id', asyncHandler(async (req, res) => {
  const expense = await db.query.expenses.findFirst({ where: eq(expenses.id, req.params.id) });
  if (!expense) throw notFound('Expense not found');
  if (expense.userId !== req.user!.id) throw forbidden();

  const editability = editableFields(expense.status, expense.zohoExpenseId);
  if (editability === 'none') {
    res.status(409).json({ error: { code: 'NOT_EDITABLE', message: editRefusalMessage(expense.status, expense.zohoExpenseId) } });
    return;
  }

  let body = updateExpenseSchema.parse(req.body);

  // Closed accounting periods lock the expense's current month — and reject
  // moving an expense into a closed month.
  const closedPeriods = await getClosedPeriods();
  const closedDate = [expense.date, body.date].find((d) => d && isInClosedPeriods(d, closedPeriods));
  if (closedDate) {
    throw createError(closedPeriodMessage(periodOf(closedDate)), 409, 'PERIOD_CLOSED');
  }

  if (editability === 'notes_only') {
    const requested = Object.keys(body).filter((k) => body[k as keyof typeof body] !== undefined);
    if (requested.some((k) => k !== 'description')) {
      res.status(409).json({ error: { code: 'NOT_EDITABLE', message: editRefusalMessage(expense.status, expense.zohoExpenseId) } });
      return;
    }
    body = { description: body.description };
  }
  const before = { ...expense };

  if (body.zohoEntity !== undefined) {
    body = { ...body, zohoEntity: (await assertActiveCompany(body.zohoEntity)) ?? undefined };
  }

  // The effective kind after this patch — an explicit expenseKind in the body
  // wins, otherwise the expense keeps whatever kind it already had.
  const effectiveKind = body.expenseKind !== undefined
    ? resolveExpenseKind(body.expenseKind, req.user!.role)
    : expense.expenseKind;

  let reimbursementPatch: { reimbursementStatus?: 'pending' } = {};
  if (body.paymentMethodId && effectiveKind !== 'partner') {
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
      ...(body.expenseKind !== undefined
        ? { expenseKind: resolveExpenseKind(body.expenseKind, req.user!.role) }
        : {}),
      amount: body.amount !== undefined ? String(body.amount) : undefined,
      updatedAt: new Date(),
    })
    .where(eq(expenses.id, req.params.id))
    .returning();

  await syncExpenseToTransaction(updated);
  await auditLog({ entityType: 'expense', entityId: expense.id, userId: req.user!.id, action: 'updated', before, after: updated });

  // Completing a pending daily expense (adding payment method, category, …)
  // auto-approves and pushes it — no accountant round-trip.
  const completion = updated.status === 'pending'
    ? await maybeAutoPushPending(updated.id, req.user!.id)
    : null;
  if (completion) {
    const fresh = await db.query.expenses.findFirst({ where: eq(expenses.id, updated.id) });
    res.json({ expense: fresh ?? updated, autoPushed: completion.autoPushed });
    return;
  }

  res.json({ expense: updated });
}));

// Submit draft for review
// Rejected → corrected expense: clone into a fresh draft (no receipts, no
// review/Zoho state) so accounting history stays intact.
router.post('/:id/clone', asyncHandler(async (req, res) => {
  const source = await db.query.expenses.findFirst({ where: eq(expenses.id, req.params.id) });
  if (!source) throw notFound('Expense not found');
  if (source.userId !== req.user!.id) throw forbidden();
  if (source.status !== 'rejected') {
    res.status(409).json({ error: { code: 'CONFLICT', message: 'Only rejected expenses can be cloned' } });
    return;
  }

  const [clone] = await db.insert(expenses).values({
    userId: req.user!.id,
    merchant: source.merchant,
    amount: source.amount,
    currency: source.currency,
    date: source.date,
    categoryId: source.categoryId,
    paymentMethodId: source.paymentMethodId,
    description: source.description,
    zohoEntity: source.zohoEntity,
    zohoExpenseAccountId: source.zohoExpenseAccountId,
    zohoExpenseAccountName: source.zohoExpenseAccountName,
    expenseKind: source.expenseKind,
    status: 'draft',
    reimbursementStatus: 'not_requested',
  }).returning();

  await syncExpenseToTransaction(clone);
  await auditLog({
    entityType: 'expense',
    entityId: clone.id,
    userId: req.user!.id,
    action: 'cloned_from_rejected',
    metadata: { sourceExpenseId: source.id },
  });

  res.status(201).json({ expense: clone });
}));

// Non-blocking duplicate check for the wizard.
const duplicateCheckSchema = z.object({
  merchant: z.string().min(1),
  amount: z.coerce.number().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

router.post('/check-duplicate', asyncHandler(async (req, res) => {
  const body = duplicateCheckSchema.parse(req.body);

  const candidates = await db.query.expenses.findMany({
    where: and(
      eq(expenses.userId, req.user!.id),
      eq(expenses.amount, String(body.amount)),
    ),
    columns: { id: true, merchant: true, amount: true, date: true, status: true },
    orderBy: [desc(expenses.createdAt)],
    limit: 50,
  });

  const duplicate = candidates.find((c) =>
    c.status !== 'rejected' && c.status !== 'draft'
    && isLikelyDuplicate(body, { merchant: c.merchant, amount: c.amount, date: c.date }),
  ) ?? null;

  res.json({ duplicate });
}));

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
  if (!expense.merchant.trim() || Number(expense.amount) <= 0) {
    res.status(409).json({ error: { code: 'INCOMPLETE_DRAFT', message: 'Merchant and amount are required before submitting' } });
    return;
  }

  const closedPeriods = await getClosedPeriods();
  if (isInClosedPeriods(expense.date, closedPeriods)) {
    throw createError(closedPeriodMessage(periodOf(expense.date)), 409, 'PERIOD_CLOSED');
  }

  // Partner spend never enters the accountant queue or the Zoho pipeline — it
  // is simply recorded as final on submit. No readiness check, no auto-push,
  // no reimbursement liability.
  if (expense.expenseKind === 'partner') {
    const [recorded] = await db.update(expenses)
      .set({ status: 'approved', integrationStatus: 'not_required', updatedAt: new Date() })
      .where(eq(expenses.id, expense.id))
      .returning();
    await auditLog({
      entityType: 'expense',
      entityId: expense.id,
      userId: req.user!.id,
      action: 'partner_expense_recorded',
      before: { status: 'draft' },
      after: { status: 'approved' },
    });
    res.json({ expense: recorded });
    return;
  }

  // Daily auto-push: complete staff-entered expenses skip accountant approval.
  // Readiness is evaluated as-if approved ("ready once approved"). Event
  // expenses (trade_show etc.), incomplete ones, and expenses for companies
  // with Zoho disabled fall through to pending.
  const company = expense.zohoEntity
    ? await db.query.companies.findFirst({ where: eq(companies.name, expense.zohoEntity) })
    : undefined;
  const readiness = evaluateZohoReadiness({ ...expense, status: 'approved' });
  if (isAutoPushEligible({
    sourceApp: expense.sourceApp,
    ready: readiness.ready,
    companyZohoEnabled: company?.zohoEnabled,
  })) {
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

  // A daily expense that would have auto-approved but for missing details:
  // tell the submitter exactly what to add so they can complete it and skip
  // the accountant entirely (see lib/pendingCompletion). requestType stays
  // null — a non-null requestType would itself block Zoho readiness.
  const missingForAutoPush = isDailyAutoPushCandidate({
    sourceApp: expense.sourceApp,
    expenseKind: expense.expenseKind,
    companyZohoEnabled: company?.zohoEnabled,
  }) && !readiness.ready ? readiness.missing : null;
  if (missingForAutoPush) {
    await db.insert(expenseMessages).values({
      expenseId: expense.id,
      senderId: req.user!.id,
      body: incompleteSubmissionMessage(missingForAutoPush),
      isSystem: true,
    });
    await notifyUser(req.user!.id, 'expense_incomplete', {
      expenseId: expense.id,
      merchant: expense.merchant,
      amount: expense.amount,
      missing: missingForAutoPush,
    });
  }

  res.json({ expense: updated, missing: missingForAutoPush ?? undefined });
}));

const bulkDeleteSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  force: z.boolean().optional(),
});

async function deleteExpenseRecord(
  expenseId: string,
  actor: { id: string; role: import('@midas/shared').UserRole },
  force: boolean,
  closedPeriods: string[],
): Promise<{ ok: true; mode: 'hard_delete' | 'soft_cancel' } | { ok: false; status: 403 | 404 | 409; code: string; message: string }> {
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

  // Closed accounting period locks deletes; admin force is the audited override.
  const adminForce = force && roleAllowed(actor.role, ['admin']);
  if (isInClosedPeriods(expense.date, closedPeriods) && !adminForce) {
    return { ok: false, status: 409, code: 'PERIOD_CLOSED', message: closedPeriodMessage(periodOf(expense.date)) };
  }

  if (decision.mode === 'soft_cancel') {
    const [updated] = await db.update(expenses)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(expenses.id, expense.id))
      .returning();
    await syncExpenseToTransaction(updated);
    await auditLog({
      entityType: 'expense',
      entityId: expense.id,
      userId: actor.id,
      action: 'cancelled',
      before: { status: expense.status },
      after: { status: 'cancelled' },
      metadata: { force: force || undefined },
    });
    return { ok: true, mode: 'soft_cancel' };
  }

  for (const r of expense.receipts) {
    await storage.delete(r.storagePath);
  }
  await removeSyncedTransaction(expense.id);
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
  return { ok: true, mode: 'hard_delete' };
}

// Bulk delete (accountant/admin cleanup + owner drafts)
router.post('/bulk-delete', asyncHandler(async (req, res) => {
  const body = bulkDeleteSchema.parse(req.body);
  const force = body.force === true;
  const actor = { id: req.user!.id, role: req.user!.role };

  const deleted: string[] = [];
  const failed: Array<{ id: string; code: string; message: string }> = [];

  const closedPeriods = await getClosedPeriods();
  for (const id of body.ids) {
    const result = await deleteExpenseRecord(id, actor, force, closedPeriods);
    if (result.ok) deleted.push(id);
    else failed.push({ id, code: result.code, message: result.message });
  }

  res.json({ deleted, failed });
}));

// Delete expense (owner draft/pending; accountant/admin any without Zoho; admin+force with Zoho)
router.delete('/:id', asyncHandler(async (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true';
  const closedPeriods = await getClosedPeriods();
  const result = await deleteExpenseRecord(req.params.id, { id: req.user!.id, role: req.user!.role }, force, closedPeriods);
  if (!result.ok) {
    if (result.status === 404) throw notFound(result.message);
    if (result.status === 403) throw forbidden();
    throw createError(result.message, result.status, result.code);
  }
  res.json({ ok: true });
}));

// Categories (read-only for all users). Only effectively-active nodes —
// a category is hidden when it OR any ancestor is inactive.
router.get('/categories/list', asyncHandler(async (_req, res) => {
  const all = await db.query.expenseCategories.findMany({
    orderBy: (c, { asc }) => [asc(c.name)],
  });
  const activeIds = effectivelyActiveIds(all);
  res.json({ categories: all.filter((c) => activeIds.has(c.id)) });
}));

export default router;
