// apps/api/src/lib/needsReview.ts
/**
 * Accountant "needs review" notifications. Every expense sends its own push;
 * the bell holds one unread row per accountant per group (a submitter's
 * expenses for one show, or for one day), with a running count. Pure.
 */
import { formatAmount } from './notifyMessages';

export type NeedsReviewReason = 'queued' | 'auto_approved';

export function groupKeyFor(e: {
  userId: string; date: string; sourceContext?: { eventId?: string } | null;
}): string {
  const eventId = e.sourceContext?.eventId;
  return eventId ? `nr:${e.userId}:event:${eventId}` : `nr:${e.userId}:day:${e.date}`;
}

/** Whether a group is for a show or for a day; decides which queue a bell row opens. */
export function groupTarget(groupKey: string | null | undefined): 'event' | 'day' {
  return groupKey?.split(':')[2] === 'event' ? 'event' : 'day';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-10-08' → 'Oct 8'. Falls back to the input when it is not a plain date. */
function shortDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return date;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

export function groupText(i: {
  submitterName: string; count: number; eventName?: string | null; date: string;
}): { title: string; body: string } {
  const what = i.count === 1 ? 'an expense' : `${i.count} expenses`;
  const where = i.eventName ? `for ${i.eventName}` : `on ${shortDate(i.date)}`;
  return { title: `${i.submitterName} submitted ${what} ${where}`, body: 'Open the review queue to see it.' };
}

export function pushText(i: {
  submitterName: string; merchant: string; amount: string | number;
  eventName?: string | null; reason: NeedsReviewReason; categoryName?: string | null;
}): { title: string; body: string } {
  const line = `${i.submitterName}: ${formatAmount(i.amount)} at ${i.merchant}`;
  if (i.reason === 'auto_approved') {
    return {
      title: 'Auto-approved expense needs you',
      body: `${line}${i.categoryName ? ` · category "${i.categoryName}"` : ''}`,
    };
  }
  return { title: 'Expense needs review', body: `${line}${i.eventName ? ` · ${i.eventName}` : ''}` };
}
