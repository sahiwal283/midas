// External app-to-app API
// Other internal apps (Argo, Milo, etc.) use this to create/query expenses in Midas.
// Auth: Bearer API key issued via POST /api/v1/admin/connections
import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { expenses, users } from '../db/schema';
import { authenticateApiKey } from '../middleware/auth';
import { asyncHandler, notFound, createError } from '../middleware/error';
import { auditLog } from '../lib/audit';

const router = Router();
router.use(authenticateApiKey as any);

const createSchema = z.object({
  merchant: z.string().min(1),
  amount: z.coerce.number().positive(),
  currency: z.string().length(3).default('USD'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  categoryId: z.string().uuid().optional(),
  description: z.string().optional(),
  sourceApp: z.string().min(1),
  sourceRefId: z.string().min(1),
  submitterEmail: z.string().email(),
});

// Create an expense on behalf of another app
router.post('/expenses', asyncHandler(async (req, res) => {
  const body = createSchema.parse(req.body);

  const user = await db.query.users.findFirst({ where: eq(users.email, body.submitterEmail) });
  if (!user) throw createError(`No Midas user found for email ${body.submitterEmail}`, 422, 'USER_NOT_FOUND');
  if (!user.isActive) throw createError('User is inactive', 422, 'USER_INACTIVE');

  const [expense] = await db.insert(expenses).values({
    userId: user.id,
    merchant: body.merchant,
    amount: String(body.amount),
    currency: body.currency,
    date: body.date,
    categoryId: body.categoryId ?? null,
    description: body.description,
    sourceApp: body.sourceApp,
    sourceRefId: body.sourceRefId,
    status: 'draft',
  }).returning();

  await auditLog({
    entityType: 'expense',
    entityId: expense.id,
    action: 'ext.created',
    metadata: { sourceApp: body.sourceApp, sourceRefId: body.sourceRefId },
    after: expense,
  });

  res.status(201).json({ expense });
}));

// Get expense status (for polling from source app)
router.get('/expenses/:id', asyncHandler(async (req, res) => {
  const expense = await db.query.expenses.findFirst({
    where: eq(expenses.id, req.params.id),
    columns: { id: true, status: true, reimbursementStatus: true, sourceApp: true, sourceRefId: true, updatedAt: true },
  });
  if (!expense) throw notFound('Expense not found');
  res.json({ expense });
}));

export default router;
