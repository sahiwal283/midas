/**
 * Database orchestration for expense message threads.
 *
 * Decisions live in expenseThread.ts (pure, tested). This module is the only
 * place that writes a message, so the audit trail and recipient notification
 * cannot be forgotten by a new caller. Both the session-auth route and the Ext
 * route go through postToThread.
 */

import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { UserRole } from '@midas/shared';
import { db } from '../db/index';
import { expenseMessages, expenses } from '../db/schema';
import { auditLog } from './audit';
import { notifyUser } from './notify';
import { truncateExcerpt } from './notifyMessages';
import { resolveMessageRecipient } from './messageRecipients';
import { decideThreadPost } from './expenseThread';

// Matches the sender columns the session-auth route has always selected — no
// email. Widening this exposes an address that the current API never has;
// keep in lockstep with any callers that need more (see Ext route review).
const SENDER_COLUMNS = { id: true, name: true, role: true } as const;

/**
 * Thread messages oldest-first. When includeInternal is false the internalNote
 * field is removed from every row — a submitter must never see it.
 */
export async function listThread(
  expenseId: string,
  opts: { includeInternal: boolean },
) {
  const rows = await db.query.expenseMessages.findMany({
    where: eq(expenseMessages.expenseId, expenseId),
    with: { sender: { columns: SENDER_COLUMNS } },
    orderBy: [asc(expenseMessages.createdAt)],
  });
  return opts.includeInternal
    ? rows
    : rows.map(({ internalNote: _n, ...m }) => m);
}

export interface PostToThreadInput {
  expenseId: string;
  senderId: string;
  senderRole: UserRole;
  body: string;
  /** Only honoured for privileged senders; callers must gate before calling. */
  requestType?: string | null;
  internalNote?: string | null;
}

/**
 * Insert a message and run every consequence: auto-transition, audit, notify.
 * Returns the stored message with its sender joined.
 */
export async function postToThread(input: PostToThreadInput) {
  const expense = await db.query.expenses.findFirst({
    where: eq(expenses.id, input.expenseId),
  });
  if (!expense) return null;

  const decision = decideThreadPost({
    status: expense.status,
    senderId: input.senderId,
    senderRole: input.senderRole,
    ownerId: expense.userId,
  });

  const [message] = await db.insert(expenseMessages).values({
    expenseId: input.expenseId,
    senderId: input.senderId,
    body: input.body,
    isSystem: false,
    requestType: input.requestType ?? null,
    internalNote: input.internalNote ?? null,
  }).returning();

  if (decision.transitionsToPending) {
    const openRequests = await db.query.expenseMessages.findMany({
      where: and(
        eq(expenseMessages.expenseId, input.expenseId),
        isNotNull(expenseMessages.requestType),
        eq(expenseMessages.isResolved, false),
      ),
      columns: { id: true },
    });

    for (const infoReq of openRequests) {
      await db.update(expenseMessages)
        .set({ isResolved: true, resolvedAt: new Date(), resolvedById: input.senderId })
        .where(eq(expenseMessages.id, infoReq.id));
    }

    await db.update(expenses)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(eq(expenses.id, input.expenseId));

    await auditLog({
      entityType: 'expense',
      entityId: expense.id,
      userId: input.senderId,
      action: 'user_responded',
      before: { status: 'awaiting_info' },
      after: { status: 'pending' },
    });
  }

  const full = await db.query.expenseMessages.findFirst({
    where: eq(expenseMessages.id, message.id),
    with: { sender: { columns: SENDER_COLUMNS } },
  });

  // expense_messages is the canonical conversation record (see CLAUDE.md), so
  // every post is audited — not just the status transition above.
  await auditLog({
    entityType: 'expense',
    entityId: expense.id,
    userId: input.senderId,
    action: 'message.posted',
    after: { messageId: message.id, excerpt: truncateExcerpt(input.body) },
  });

  // Tell the other side. In-app + push only: threads would flood an inbox.
  const recipient = resolveMessageRecipient({
    isSystem: false,
    senderId: input.senderId,
    senderRole: input.senderRole,
    ownerId: expense.userId,
    reviewedById: expense.reviewedById,
  });
  if (recipient) {
    await notifyUser(recipient, 'message', {
      expenseId: expense.id,
      merchant: expense.merchant ?? 'an expense',
      amount: expense.amount ?? '0',
      senderName: full?.sender?.name,
      excerpt: truncateExcerpt(input.body),
    }, { email: false });
  }

  return full;
}
