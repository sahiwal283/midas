/**
 * Pure notification message builders — no env/db imports so Vitest can run
 * this without a database (see src/__tests__/notifyMessages.test.ts).
 */

export type NotificationType = 'action_required' | 'approved' | 'rejected' | 'reimbursement_paid';

export interface NotificationInput {
  merchant: string;
  amount: string | number;
  /** Reviewer note — appended to the body for rejections when present. */
  note?: string;
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
    case 'reimbursement_paid':
      return {
        title: 'Reimbursement paid',
        body: `Your ${amount} reimbursement for ${i.merchant} was marked paid.`,
      };
  }
}
