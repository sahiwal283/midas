/**
 * Database orchestration for expense message threads.
 *
 * Decisions live in expenseThread.ts (pure, tested). This is the only path
 * the session-auth and Ext *thread* routes share for posting a message, so
 * the audit trail and recipient notification cannot be forgotten by either.
 * Other writers (routes/accountant.ts, routes/expenses.ts,
 * drizzleImportTarget.ts) insert directly with their own audit/notify and do
 * not go through postToThread.
 */

import { and, asc, desc, eq, inArray, isNotNull, ne, or } from 'drizzle-orm';
import { resolveMentions, type UserRole } from '@midas/shared';
import { db } from '../db/index';
import { expenseMessages, expenses, users } from '../db/schema';
import { auditLog } from './audit';
import { notifyUser } from './notify';
import { truncateExcerpt } from './notifyMessages';
import { planMessageNotifications } from './messageRecipients';
import { decideThreadPost } from './expenseThread';

// Base sender columns the session-auth route has always selected — no email
// by default. postToThread's includeSenderEmail opts in per call (see below);
// keep this in lockstep with listThread's equivalent default.
const SENDER_COLUMNS = { id: true, name: true, role: true } as const;

/**
 * Thread messages oldest-first. When includeInternal is false the internalNote
 * field is removed from every row — a submitter must never see it.
 *
 * includeSenderEmail is an explicit opt-in, off by default. The session-auth
 * route must never see it (that response is byte-identical to before this
 * refactor). The Ext route passes true deliberately: Trade Show and Midas
 * user ids live in different id spaces, so the Ext DTO uses sender.email as
 * the join key to tell whether a message was written by the viewing user.
 */
export async function listThread(
  expenseId: string,
  opts: { includeInternal: boolean; includeSenderEmail?: boolean },
) {
  const senderColumns = {
    id: true, name: true, role: true,
    email: opts.includeSenderEmail === true,
  } as const satisfies Record<string, boolean>;

  const rows = await db.query.expenseMessages.findMany({
    where: eq(expenseMessages.expenseId, expenseId),
    with: { sender: { columns: senderColumns } },
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
  /**
   * Same opt-in as listThread's includeSenderEmail, off by default so the
   * session-auth route's POST response stays byte-identical. The Ext route
   * passes true so its POST response matches its GET response shape.
   */
  includeSenderEmail?: boolean;
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

  const senderColumns = {
    ...SENDER_COLUMNS,
    email: input.includeSenderEmail === true,
  } as const satisfies Record<string, boolean>;

  const full = await db.query.expenseMessages.findFirst({
    where: eq(expenseMessages.id, message.id),
    with: { sender: { columns: senderColumns } },
  });

  // Only people who can open the thread can be mentioned; any other @handle
  // is just text. Skip the lookup for the common message with no @ in it.
  const mentionedIds = input.body.includes('@')
    ? resolveMentions(input.body, await listMentionable(expense.userId)).map((u) => u.id)
    : [];

  // expense_messages is the canonical conversation record (see CLAUDE.md), so
  // every post is audited — not just the status transition above.
  await auditLog({
    entityType: 'expense',
    entityId: expense.id,
    userId: input.senderId,
    action: 'message.posted',
    after: {
      messageId: message.id,
      excerpt: truncateExcerpt(input.body),
      ...(mentionedIds.length > 0 ? { mentionedUserIds: mentionedIds } : {}),
    },
  });

  // Tell the other side, plus anyone mentioned. In-app + push only: threads
  // would flood an inbox. Only a submitter's post needs the accountant-side
  // lookups.
  const fromOwner = input.senderId === expense.userId;
  const planned = planMessageNotifications({
    isSystem: false,
    senderId: input.senderId,
    senderRole: input.senderRole,
    ownerId: expense.userId,
    reviewedById: expense.reviewedById,
    lastStaffPosterId: fromOwner ? await lastStaffPoster(expense.id, input.senderId) : null,
    accountantIds: fromOwner ? await activeAccountantIds() : [],
    mentionedIds,
  });
  for (const { userId: recipient, type } of planned) {
    await notifyUser(recipient, type, {
      expenseId: expense.id,
      ownerId: expense.userId,
      merchant: expense.merchant ?? 'an expense',
      amount: expense.amount ?? '0',
      senderName: full?.sender?.name,
      excerpt: truncateExcerpt(input.body),
      toStaff: recipient !== expense.userId,
    }, { email: false });
  }

  return full;
}

/** Roles that answer for the accountant side of a conversation. */
const STAFF_ROLES = ['accountant', 'admin', 'developer'] as const;

/**
 * Who can be @-mentioned on an expense: exactly the active users who can open
 * its thread (see decideThreadAccess) — staff, plus the submitter.
 */
export async function listMentionable(ownerId: string) {
  return db.query.users.findMany({
    where: and(
      eq(users.isActive, true),
      or(inArray(users.role, [...STAFF_ROLES]), eq(users.id, ownerId)),
    ),
    columns: { id: true, username: true, name: true, role: true },
    orderBy: [asc(users.name)],
  });
}

/** The active staff member who most recently wrote in this thread, if any. */
async function lastStaffPoster(expenseId: string, exceptUserId: string): Promise<string | null> {
  const [row] = await db
    .select({ senderId: expenseMessages.senderId })
    .from(expenseMessages)
    .innerJoin(users, eq(users.id, expenseMessages.senderId))
    .where(and(
      eq(expenseMessages.expenseId, expenseId),
      eq(expenseMessages.isSystem, false),
      ne(expenseMessages.senderId, exceptUserId),
      inArray(users.role, [...STAFF_ROLES]),
      eq(users.isActive, true),
    ))
    .orderBy(desc(expenseMessages.createdAt))
    .limit(1);
  return row?.senderId ?? null;
}

async function activeAccountantIds(): Promise<string[]> {
  const rows = await db.query.users.findMany({
    where: and(eq(users.role, 'accountant'), eq(users.isActive, true)),
    columns: { id: true },
  });
  return rows.map((u) => u.id);
}
