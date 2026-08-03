import type { ExpenseStatus, ReimbursementStatus } from '../types';

// Accountant-facing labels (precise workflow state)
const ACCOUNTANT_LABELS: Record<ExpenseStatus, string> = {
  draft: 'Draft',
  pending: 'Needs Review',
  in_review: 'In Review',
  awaiting_info: 'Awaiting User',
  approved: 'Approved',
  zoho_sync_failed: 'Zoho Sync Failed',
  rejected: 'Rejected',
};

// User-facing labels (plain language, no jargon).
// Exported as the single source of truth for employee-facing status text (see Dashboard).
export const USER_LABELS: Record<ExpenseStatus, string> = {
  draft: 'Draft',
  pending: 'Submitted — waiting for review',
  in_review: 'Under review',
  awaiting_info: 'Action needed',
  approved: 'Approved',
  zoho_sync_failed: 'Sent to accounting',
  rejected: 'Rejected',
};

const STATUS_STYLES: Record<ExpenseStatus, string> = {
  draft: 'bg-gray-100 text-gray-700',
  pending: 'bg-yellow-100 text-yellow-800',
  in_review: 'bg-blue-100 text-blue-800',
  awaiting_info: 'bg-amber-100 text-amber-900 ring-1 ring-amber-400',
  approved: 'bg-green-100 text-green-800',
  zoho_sync_failed: 'bg-red-100 text-red-800',
  rejected: 'bg-red-100 text-red-800',
};

const REIMB_STYLES: Record<ReimbursementStatus, string> = {
  not_requested: 'bg-gray-100 text-gray-500',
  pending: 'bg-orange-100 text-orange-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  paid: 'bg-emerald-100 text-emerald-700',
};

const REIMB_LABELS: Record<ReimbursementStatus, string> = {
  not_requested: 'No Reimbursement',
  pending: 'Reimbursement Pending',
  approved: 'Reimbursement Approved',
  rejected: 'Reimbursement Rejected',
  paid: 'Reimbursed',
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

export function ReimbursementBadge({ status }: { status: ReimbursementStatus }) {
  if (status === 'not_requested') return null;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${REIMB_STYLES[status]}`}>
      {REIMB_LABELS[status]}
    </span>
  );
}
