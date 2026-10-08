// apps/api/src/lib/needsReviewDb.ts
import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { expenses, notifications, users } from '../db/schema';

export interface NeedsReviewExpense {
  id: string;
  userId: string;
  submitterName: string;
  merchant: string;
  amount: string;
  date: string;
  sourceContext: { eventId?: string; eventName?: string } | null;
  sourceLabel: string | null;
  categoryName: string | null;
  categoryNeedsAccountant: boolean;
}

export async function loadNeedsReviewExpense(expenseId: string): Promise<NeedsReviewExpense | null> {
  const row = await db.query.expenses.findFirst({
    where: eq(expenses.id, expenseId),
    columns: { id: true, userId: true, merchant: true, amount: true, date: true, sourceContext: true, sourceLabel: true },
    with: {
      user: { columns: { name: true } },
      category: { columns: { name: true, needsAccountant: true } },
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    submitterName: row.user?.name ?? 'Someone',
    merchant: row.merchant,
    amount: String(row.amount),
    date: String(row.date),
    sourceContext: row.sourceContext ?? null,
    sourceLabel: row.sourceLabel,
    categoryName: row.category?.name ?? null,
    categoryNeedsAccountant: row.category?.needsAccountant ?? false,
  };
}

/** Active accountants, never the submitter. Accountant role only: not admin, not developer. */
export async function activeAccountantIds(exceptUserId: string): Promise<string[]> {
  const rows = await db.query.users.findMany({
    where: and(eq(users.role, 'accountant'), eq(users.isActive, true), ne(users.id, exceptUserId)),
    columns: { id: true },
  });
  return rows.map((u) => u.id);
}

/**
 * Add one to the recipient's unread row for this group, or start a new row.
 * One statement, keyed on the partial unique index notifications_unread_group_idx,
 * so two expenses arriving together still end as one row with count 2. The
 * WHERE on the conflict target must repeat the index predicate exactly, or
 * Postgres will not match the partial index.
 *
 * The row points at no expense: notifications.expense_id is ON DELETE CASCADE,
 * so pointing it at one member would delete the whole group's row and count
 * with that expense. Nothing reads it on a grouped row; the link comes from
 * group_key.
 */
export async function bumpGroup(
  userId: string, groupKey: string,
  initial: { title: string; body: string },
): Promise<{ id: string; count: number }> {
  const result = await db.execute(sql`
    INSERT INTO notifications (user_id, type, title, body, expense_id, group_key, count)
    VALUES (${userId}, 'needs_review', ${initial.title}, ${initial.body}, NULL, ${groupKey}, 1)
    ON CONFLICT (user_id, group_key) WHERE read_at IS NULL AND group_key IS NOT NULL
    DO UPDATE SET count = notifications.count + 1,
                  created_at = now()
    RETURNING id, count
  `);
  const row = result.rows[0] as { id: string; count: number };
  return { id: row.id, count: Number(row.count) };
}

/**
 * Rewrite a group's wording for a count above one. Conditional on the row still
 * holding the count this writer saw, so a writer overtaken by a later bump
 * changes nothing and the text never lags the count.
 */
export async function setGroupText(notificationId: string, count: number, title: string, body: string): Promise<void> {
  await db.update(notifications).set({ title, body })
    .where(and(eq(notifications.id, notificationId), eq(notifications.count, count)));
}
