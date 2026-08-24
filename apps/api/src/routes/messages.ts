import { Router } from 'express';
import { z } from 'zod';
import { eq, asc, and, isNotNull } from 'drizzle-orm';
import { db } from '../db/index';
import { expenseMessages, expenses } from '../db/schema';
import { authenticate } from '../middleware/auth';
import { asyncHandler, notFound, forbidden } from '../middleware/error';
import { auditLog } from '../lib/audit';
import { roleAllowed } from '../lib/roles';
import { notifyUser } from '../lib/notify';
import { resolveMessageRecipient } from '../lib/messageRecipients';
import { truncateExcerpt } from '../lib/notifyMessages';

const router = Router({ mergeParams: true });
router.use(authenticate);

const postMessageSchema = z.object({
  body: z.string().trim().min(1).max(2000),
});

// Get all messages for an expense (owner or accountant/admin)
router.get('/', asyncHandler(async (req, res) => {
  const expense = await db.query.expenses.findFirst({ where: eq(expenses.id, req.params.expenseId) });
  if (!expense) throw notFound('Expense not found');
  const isOwner = expense.userId === req.user!.id;
  // Accountant/admin (and developer, via roleAllowed) — NOT every non-'user'
  // role. Partners must not read other people's conversations or internal notes.
  const isPrivileged = roleAllowed(req.user!.role, ['accountant', 'admin']);
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
  const isPrivileged = roleAllowed(req.user!.role, ['accountant', 'admin']);
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

  // expense_messages is the canonical conversation record (see CLAUDE.md), so
  // every post is audited — not just the status transition above.
  await auditLog({
    entityType: 'expense',
    entityId: expense.id,
    userId: req.user!.id,
    action: 'message.posted',
    after: { messageId: message.id, excerpt: truncateExcerpt(body) },
  });

  // Tell the other side. In-app + push only: threads would flood an inbox.
  const recipient = resolveMessageRecipient({
    isSystem: false,
    senderId: req.user!.id,
    senderRole: req.user!.role,
    ownerId: expense.userId,
    reviewedById: expense.reviewedById,
  });
  if (recipient) {
    await notifyUser(recipient, 'message', {
      expenseId: expense.id,
      merchant: expense.merchant ?? 'an expense',
      amount: expense.amount ?? '0',
      senderName: full?.sender?.name,
      excerpt: truncateExcerpt(body),
    }, { email: false });
  }

  res.status(201).json({ message: full });
}));

export default router;
