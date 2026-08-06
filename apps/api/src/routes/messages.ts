import { Router } from 'express';
import { z } from 'zod';
import { eq, asc, and, isNotNull } from 'drizzle-orm';
import { db } from '../db/index';
import { expenseMessages, expenses } from '../db/schema';
import { authenticate } from '../middleware/auth';
import { asyncHandler, notFound, forbidden } from '../middleware/error';
import { auditLog } from '../lib/audit';

const router = Router({ mergeParams: true });
router.use(authenticate);

const postMessageSchema = z.object({
  body: z.string().min(1).max(2000),
});

// Get all messages for an expense (owner or accountant/admin)
router.get('/', asyncHandler(async (req, res) => {
  const expense = await db.query.expenses.findFirst({ where: eq(expenses.id, req.params.expenseId) });
  if (!expense) throw notFound('Expense not found');
  const isOwner = expense.userId === req.user!.id;
  const isPrivileged = req.user!.role !== 'user';
  if (!isOwner && !isPrivileged) throw forbidden();

  const rows = await db.query.expenseMessages.findMany({
    where: eq(expenseMessages.expenseId, req.params.expenseId),
    with: { sender: { columns: { id: true, name: true, role: true } } },
    orderBy: [asc(expenseMessages.createdAt)],
  });

  // Strip internal notes from non-privileged users
  const messages = isPrivileged
    ? rows
    : rows.map(({ internalNote: _n, ...m }) => m);

  res.json({ messages });
}));

// Post a message
router.post('/', asyncHandler(async (req, res) => {
  const expense = await db.query.expenses.findFirst({ where: eq(expenses.id, req.params.expenseId) });
  if (!expense) throw notFound('Expense not found');
  const isOwner = expense.userId === req.user!.id;
  const isPrivileged = req.user!.role !== 'user';
  if (!isOwner && !isPrivileged) throw forbidden();

  const { body } = postMessageSchema.parse(req.body);

  const [message] = await db.insert(expenseMessages).values({
    expenseId: req.params.expenseId,
    senderId: req.user!.id,
    body,
    isSystem: false,
  }).returning();

  // Auto-transition: expense owner replying on an awaiting_info expense → back to pending approval.
  // Resolves all open request messages (regardless of request type).
  if (expense.status === 'awaiting_info' && isOwner) {
    const openRequests = await db.query.expenseMessages.findMany({
      where: and(
        eq(expenseMessages.expenseId, req.params.expenseId),
        isNotNull(expenseMessages.requestType),
        eq(expenseMessages.isResolved, false),
      ),
      columns: { id: true },
    });

    for (const infoReq of openRequests) {
      await db.update(expenseMessages)
        .set({ isResolved: true, resolvedAt: new Date(), resolvedById: req.user!.id })
        .where(eq(expenseMessages.id, infoReq.id));
    }

    await db.update(expenses)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(eq(expenses.id, req.params.expenseId));

    await auditLog({
      entityType: 'expense',
      entityId: expense.id,
      userId: req.user!.id,
      action: 'user_responded',
      before: { status: 'awaiting_info' },
      after: { status: 'pending' },
    });
  }

  const full = await db.query.expenseMessages.findFirst({
    where: eq(expenseMessages.id, message.id),
    with: { sender: { columns: { id: true, name: true, role: true } } },
  });

  res.status(201).json({ message: full });
}));

export default router;
