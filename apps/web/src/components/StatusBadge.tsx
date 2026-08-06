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
};

const STATUS_STYLES: Record<ExpenseStatus, string> = {
  draft: 'bg-gray-100 text-gray-700',
  pending: 'bg-yellow-100 text-yellow-800',
  in_review: 'bg-yellow-100 text-yellow-800',
  awaiting_info: 'bg-amber-100 text-amber-900 ring-1 ring-amber-400',
  approved: 'bg-green-100 text-green-800',
  zoho_sync_failed: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-800',
};

const REIMB_STYLES: Record<ReimbursementStatus, string> = {
  not_requested: 'bg-gray-100 text-gray-500',
  pending: 'bg-orange-100 text-orange-700',
  approved: 'bg-amber-100 text-amber-800',
  rejected: 'bg-red-100 text-red-700',
  paid: 'bg-emerald-100 text-emerald-700',
};

const REIMB_LABELS: Record<ReimbursementStatus, string> = {
  not_requested: 'Not requested',
  pending: 'Needs reimbursement',
  approved: 'Approved (pending payment)',
  rejected: 'Reimbursement rejected',
  paid: 'Paid',
};

interface StatusBadgeProps {
  status: ExpenseStatus;
  variant?: 'user' | 'accountant';
}

export function StatusBadge({ status, variant = 'accountant' }: StatusBadgeProps) {
  const label = variant === 'user' ? USER_LABELS[status] : ACCOUNTANT_LABELS[status];
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}>
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
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${REIMB_STYLES[status]}`}>
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
      <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800">
        Sync failed
      </span>
    );
  }
  if (zohoExpenseId) {
    return (
      <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
        Pushed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600">
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
