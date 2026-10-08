// apps/api/src/lib/notifyNeedsReview.ts
import { logger } from './logger';
import { sendPushToUser } from './push';
import { groupKeyFor, groupText, pushText, type NeedsReviewReason } from './needsReview';
import { activeAccountantIds, bumpGroup, loadNeedsReviewExpense, setGroupText } from './needsReviewDb';

/**
 * Tell the accountants an expense needs them: one grouped, counted bell row
 * each and one push for this expense. No email. `auto_approved` only notifies
 * when the expense's category is marked "needs accountant". Never throws:
 * a notification must not fail the submission that caused it.
 */
export async function notifyNeedsReview(expenseId: string, reason: NeedsReviewReason): Promise<void> {
  try {
    const expense = await loadNeedsReviewExpense(expenseId);
    if (!expense) return;
    if (reason === 'auto_approved' && !expense.categoryNeedsAccountant) return;

    const recipients = await activeAccountantIds(expense.userId);
    if (recipients.length === 0) return;

    const eventName = expense.sourceContext?.eventName ?? expense.sourceLabel ?? null;
    const groupKey = groupKeyFor(expense);
    const push = pushText({
      submitterName: expense.submitterName, merchant: expense.merchant, amount: expense.amount,
      eventName, reason, categoryName: expense.categoryName,
    });

    for (const userId of recipients) {
      try {
        const textFor = (count: number) => groupText({
          submitterName: expense.submitterName, count, eventName, date: expense.date,
        });
        const group = await bumpGroup(userId, groupKey, expense.id, textFor(1));
        // One push per expense. No notificationId: tapping one expense's push
        // must not mark the whole group read. A per-expense tag keeps pushes
        // from replacing each other on the lock screen.
        void sendPushToUser(userId, {
          title: push.title, body: push.body,
          url: `/accountant/${expense.id}`,
          tag: `needs-review-${expense.id}`,
        });
        // The row was born with the count-1 wording; only a bump needs a rewrite.
        // After the push, so a failed text write can never hold it up.
        if (group.count > 1) {
          try {
            const text = textFor(group.count);
            await setGroupText(group.id, group.count, text.title, text.body);
          } catch (err) {
            logger.error({ err, userId, expenseId }, 'needs_review group text update failed');
          }
        }
      } catch (err) {
        logger.error({ err, userId, expenseId }, 'needs_review notification failed for one accountant');
      }
    }
  } catch (err) {
    logger.error({ err, expenseId }, 'needs_review notification failed');
  }
}
