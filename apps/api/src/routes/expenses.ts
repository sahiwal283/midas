import { Router } from 'express';
import { z } from 'zod';
import { eq, and, desc, or } from 'drizzle-orm';
import { db } from '../db/index';
import { expenses, expenseCategories } from '../db/schema';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler, notFound, forbidden } from '../middleware/error';
import { auditLog } from '../lib/audit';

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

  const [expense] = await db.insert(expenses).values({
    userId: req.user!.id,
    merchant: body.merchant,
    amount: String(body.amount),
    currency: body.currency,
    date: body.date,
    categoryId: body.categoryId ?? null,
    paymentMethodId: body.paymentMethodId ?? null,
    description: body.description,
    status: 'draft',
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

  const [updated] = await db.update(expenses)
    .set({ ...body, amount: body.amount !== undefined ? String(body.amount) : undefined, updatedAt: new Date() })
    .where(eq(expenses.id, req.params.id))
    .returning();

  await auditLog({ entityType: 'expense', entityId: expense.id, userId: req.user!.id, action: 'updated', before, after: updated });

  res.json({ expense: updated });
}));

// Submit draft for review
router.post('/:id/submit', asyncHandler(async (req, res) => {
  const expense = await db.query.expenses.findFirst({ where: eq(expenses.id, req.params.id) });
  if (!expense) throw notFound('Expense not found');
  if (expense.userId !== req.user!.id) throw forbidden();
  if (expense.status !== 'draft') {
    res.status(409).json({ error: { code: 'CONFLICT', message: 'Expense is not in draft status' } });
    return;
  }

  const [updated] = await db.update(expenses)
    .set({ status: 'pending', updatedAt: new Date() })
    .where(eq(expenses.id, req.params.id))
    .returning();

  await auditLog({ entityType: 'expense', entityId: expense.id, userId: req.user!.id, action: 'submitted', before: { status: 'draft' }, after: { status: 'pending' } });

  res.json({ expense: updated });
}));

// Delete own draft expense
router.delete('/:id', asyncHandler(async (req, res) => {
  const expense = await db.query.expenses.findFirst({ where: eq(expenses.id, req.params.id) });
  if (!expense) throw notFound('Expense not found');
  if (expense.userId !== req.user!.id) throw forbidden();
  if (expense.status !== 'draft') {
    res.status(409).json({ error: { code: 'CONFLICT', message: 'Only draft expenses can be deleted' } });
    return;
  }

  await db.delete(expenses).where(eq(expenses.id, req.params.id));
  await auditLog({ entityType: 'expense', entityId: expense.id, userId: req.user!.id, action: 'deleted' });

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
