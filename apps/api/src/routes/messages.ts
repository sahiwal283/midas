import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { expenses } from '../db/schema';
import { authenticate } from '../middleware/auth';
import { asyncHandler, notFound, forbidden } from '../middleware/error';
import { decideThreadAccess } from '../lib/expenseThread';
import { listThread, postToThread } from '../lib/expenseThreadDb';

const router = Router({ mergeParams: true });
router.use(authenticate);

const postMessageSchema = z.object({
  body: z.string().trim().min(1).max(2000),
});

/** Owner or accountant/admin (developer via roleAllowed). Partners are excluded. */
async function loadAndAuthorize(req: { params: { expenseId: string }; user?: { id: string; role: string } }) {
  const expense = await db.query.expenses.findFirst({ where: eq(expenses.id, req.params.expenseId) });
  if (!expense) throw notFound('Expense not found');
  const access = decideThreadAccess({
    viewerId: req.user!.id,
    viewerRole: req.user!.role as never,
    ownerId: expense.userId,
  });
  if (!access.allowed) throw forbidden();
  return { expense, access };
}

// Get all messages for an expense
router.get('/', asyncHandler(async (req, res) => {
  const { access } = await loadAndAuthorize(req as never);
  const messages = await listThread(req.params.expenseId, {
    includeInternal: access.includeInternal,
  });
  res.json({ messages });
}));

// Post a message
router.post('/', asyncHandler(async (req, res) => {
  await loadAndAuthorize(req as never);
  const { body } = postMessageSchema.parse(req.body);

  const message = await postToThread({
    expenseId: req.params.expenseId,
    senderId: req.user!.id,
    senderRole: req.user!.role as never,
    body,
  });
  if (!message) throw notFound('Expense not found');

  res.status(201).json({ message });
}));

export default router;
