/**
 * Pure notification message builders — no env/db imports so Vitest can run
 * this without a database (see src/__tests__/notifyMessages.test.ts).
 */

export type NotificationType = 'action_required' | 'approved' | 'rejected' | 'reimbursement_paid' | 'expense_incomplete' | 'message';

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
    case 'message':
      return {
        title: 'New message on your expense',
        body: `${i.senderName ?? 'Someone'} on your ${amount} expense at ${i.merchant}: `
          + `"${i.excerpt ?? ''}"`,
      };
    case 'reimbursement_paid':
      return {
        title: 'Reimbursement paid',
        body: `Your ${amount} reimbursement for ${i.merchant} was marked paid.`,
      };
  }
}
