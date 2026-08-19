import type { ExpenseStatus, ReimbursementStatus } from '../types';

/**
 * Approval-facing labels (accountant).
 * Zoho push state is separate — use ZohoPushBadge, not expense.status.
 */
const ACCOUNTANT_LABELS: Record<ExpenseStatus, string> = {
  draft: 'Draft',
  pending: 'Pending approval',
  in_review: 'Pending approval',
  awaiting_info: 'Needs further review',
  approved: 'Approved',
  zoho_sync_failed: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

// User-facing labels (plain language). Exported for Dashboard etc.
export const USER_LABELS: Record<ExpenseStatus, string> = {
  draft: 'Draft',
  pending: 'Pending approval',
  in_review: 'Pending approval',
  awaiting_info: 'Needs further review',
  approved: 'Approved',
  zoho_sync_failed: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

const STATUS_STYLES: Record<ExpenseStatus, string> = {
  draft: 'bg-brand-50 text-muted',
  pending: 'bg-gold-100 text-gold-800',
  in_review: 'bg-gold-100 text-gold-800',
  awaiting_info: 'bg-amber-100 text-amber-900 ring-1 ring-amber-400',
  approved: 'bg-success/15 text-success',
  zoho_sync_failed: 'bg-success/15 text-success',
  rejected: 'bg-danger/15 text-danger',
  cancelled: 'bg-brand-50 text-muted',
};

const REIMB_STYLES: Record<ReimbursementStatus, string> = {
  not_requested: 'bg-brand-50 text-muted',
  pending: 'bg-gold-100 text-gold-800',
  approved: 'bg-amber-100 text-amber-900',
  rejected: 'bg-danger/15 text-danger',
  paid: 'bg-success/15 text-success',
};

const REIMB_LABELS: Record<ReimbursementStatus, string> = {
  not_requested: 'Not requested',
  pending: 'Needs reimbursement',
  approved: 'Approved (pending payment)',
  rejected: 'Reimbursement rejected',
  paid: 'Paid',
};

const BADGE = 'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium';

/**
 * Employee-facing label. Approved expenses distinguish "made it to the books"
 * (Accounting complete) from plain approval; a failed sync is still just
 * "Approved" to the employee — the retry is accounting's concern.
 */
export function userStatusLabel(status: ExpenseStatus, zohoExpenseId?: string | null): string {
  if ((status === 'approved' || status === 'zoho_sync_failed') && zohoExpenseId) {
    return 'Accounting complete';
  }
  return USER_LABELS[status] ?? status;
}

interface StatusBadgeProps {
  status: ExpenseStatus;
  variant?: 'user' | 'accountant';
  /** Pass on user-variant badges so approved expenses can show "Accounting complete". */
  zohoExpenseId?: string | null;
}

export function StatusBadge({ status, variant = 'accountant', zohoExpenseId }: StatusBadgeProps) {
  const label = variant === 'user' ? userStatusLabel(status, zohoExpenseId) : ACCOUNTANT_LABELS[status];
  return (
    <span className={`${BADGE} ${STATUS_STYLES[status]}`}>
      {label}
    </span>
  );
}

export function ReimbursementBadge({
  status,
  showIdle = false,
}: {
  status: ReimbursementStatus;
  /** When true, also render "Not requested" (accountant forms). */
  showIdle?: boolean;
}) {
  if (status === 'not_requested' && !showIdle) return null;
  return (
    <span className={`${BADGE} ${REIMB_STYLES[status]}`}>
      {REIMB_LABELS[status]}
    </span>
  );
}

/** Zoho sync is binary for accountants: Not pushed | Pushed (+ sync failed). */
export function ZohoPushBadge({
  zohoExpenseId,
  syncFailed = false,
}: {
  zohoExpenseId: string | null | undefined;
  syncFailed?: boolean;
}) {
  if (syncFailed && !zohoExpenseId) {
    return (
      <span className={`${BADGE} bg-danger/15 text-danger`}>
        Sync failed
      </span>
    );
  }
  if (zohoExpenseId) {
    return (
      <span className={`${BADGE} bg-success/15 text-success`}>
        Pushed
      </span>
    );
  }
  return (
    <span className={`${BADGE} bg-brand-50 text-muted`}>
      Not pushed
    </span>
  );
}

export const REIMBURSEMENT_OPTIONS: Array<{ value: ReimbursementStatus; label: string }> = [
  { value: 'not_requested', label: 'Not requested' },
  { value: 'pending', label: 'Needs reimbursement' },
  { value: 'approved', label: 'Approved (pending payment)' },
  { value: 'rejected', label: 'Reimbursement rejected' },
  { value: 'paid', label: 'Paid' },
];
