/**
 * Pure notification message builders — no env/db imports so Vitest can run
 * this without a database (see src/__tests__/notifyMessages.test.ts).
 */

export type NotificationType = 'action_required' | 'approved' | 'rejected' | 'reimbursement_paid' | 'expense_incomplete' | 'message' | 'mention';

export interface NotificationInput {
  merchant: string;
  amount: string | number;
  /** Reviewer note — appended to the body for rejections when present. */
  note?: string;
  /** Missing readiness items — listed in the body for incomplete submissions. */
  missing?: string[];
  /** Display name of whoever posted, for conversation notifications. */
  senderName?: string;
  /** Already-truncated message text — see truncateExcerpt. */
  excerpt?: string;
  /**
   * True when a conversation notification goes to someone other than the
   * submitter, for whom the expense is not "yours".
   */
  toStaff?: boolean;
}

/** Longest message excerpt carried into a notification body. */
const EXCERPT_LIMIT = 120;

/**
 * One-line preview of a message: whitespace collapsed, cut at a word boundary
 * when it runs long. Push payloads and email subjects are both size-sensitive,
 * and a wall of text in the notification bell helps nobody.
 */
export function truncateExcerpt(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= EXCERPT_LIMIT) return flat;

  const cut = flat.slice(0, EXCERPT_LIMIT);
  const lastSpace = cut.lastIndexOf(' ');
  // An unbroken token longer than the limit has no boundary to cut on.
  return `${lastSpace > 0 ? cut.slice(0, lastSpace) : cut}…`;
}

/** "12.5" | 12.5 → "$12.50"; falls back to the raw string when not numeric. */
export function formatAmount(amount: string | number): string {
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n)) return `$${amount}`;
  return `$${n.toFixed(2)}`;
}

export function buildNotification(
  type: NotificationType,
  i: NotificationInput,
): { title: string; body: string } {
  const amount = formatAmount(i.amount);
  switch (type) {
    case 'action_required':
      return {
        title: 'Action required: expense needs information',
        body: `Your accountant needs additional information for your ${amount} expense at ${i.merchant}.`,
      };
    case 'approved':
      return {
        title: 'Expense approved',
        body: `Your ${amount} expense at ${i.merchant} was approved.`,
      };
    case 'rejected':
      return {
        title: 'Expense rejected',
        body: `Your ${amount} expense at ${i.merchant} was rejected.`
          + (i.note ? ` Note: ${i.note}` : ''),
      };
    case 'expense_incomplete':
      return {
        title: 'Your expense is missing details',
        body: `Your ${amount} expense at ${i.merchant} was submitted without: `
          + `${(i.missing ?? []).join(', ')}. Add the missing item(s) and it will be `
          + 'approved automatically — no accountant review needed.',
      };
    case 'message': {
      const sender = i.senderName ?? 'Someone';
      return {
        title: i.toStaff ? `${sender} replied on an expense` : 'New message on your expense',
        body: `${sender} on ${i.toStaff ? 'their' : 'your'} ${amount} expense at ${i.merchant}: `
          + `"${i.excerpt ?? ''}"`,
      };
    }
    case 'mention': {
      const sender = i.senderName ?? 'Someone';
      // A mentioned colleague may have no tie to the expense at all, so it is
      // "an expense" to them — only the submitter is told it is theirs.
      return {
        title: `${sender} mentioned you on ${i.toStaff ? 'an' : 'your'} expense`,
        body: `${sender} on ${i.toStaff ? 'a' : 'your'} ${amount} expense at ${i.merchant}: `
          + `"${i.excerpt ?? ''}"`,
      };
    }
    case 'reimbursement_paid':
      return {
        title: 'Reimbursement paid',
        body: `Your ${amount} reimbursement for ${i.merchant} was marked paid.`,
      };
  }
}

export interface UnreadNotification {
  id: string;
  title: string;
  body: string | null;
  /** Where tapping it leads — see lib/notificationLinks. */
  path: string;
}

export interface CatchUpPush {
  title: string;
  body: string;
  url: string;
  tag: string;
  /** Set only when the push stands for exactly one notification. */
  notificationId?: string;
}

/**
 * The single push a device gets the moment it enables notifications, covering
 * whatever its owner has not read yet. Notifications raised before a device
 * subscribed were never delivered anywhere but the bell, so this is how they
 * finally reach the lock screen — one push, not one per backlog item.
 *
 * `unread` is newest-first. Returns null when there is nothing to say.
 */
export function buildCatchUpPush(unread: UnreadNotification[]): CatchUpPush | null {
  if (unread.length === 0) return null;

  const [latest] = unread;
  if (unread.length === 1) {
    return {
      title: latest.title,
      body: latest.body ?? '',
      url: latest.path,
      tag: 'catch-up',
      notificationId: latest.id,
    };
  }
  return {
    title: `You have ${unread.length} unread notifications`,
    body: `Latest: ${latest.title}${latest.body ? ` — ${latest.body}` : ''}`,
    url: '/dashboard',
    tag: 'catch-up',
  };
}
