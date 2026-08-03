import type { ExpenseStatus, ReimbursementStatus } from '@midas/shared';

/** Map Trade Show / import status strings → Midas expense_status. */
export function mapImportExpenseStatus(raw: string | null | undefined): ExpenseStatus {
  if (!raw) return 'pending';
  const key = raw.trim().toLowerCase();
  switch (key) {
    case 'draft':
      return 'draft';
    case 'pending':
      return 'pending';
    case 'in_review':
    case 'in review':
      return 'in_review';
    case 'awaiting_info':
    case 'needs further review':
    case 'needs_further_review':
      return 'awaiting_info';
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    case 'zoho_sync_failed':
      return 'zoho_sync_failed';
    default:
      return 'pending';
  }
}

/** Map Trade Show / import reimbursement strings → Midas reimbursement_status. */
export function mapImportReimbursementStatus(
  raw: string | null | undefined,
  reimbursementRequired?: boolean,
): ReimbursementStatus {
  if (raw) {
    const key = raw.trim().toLowerCase();
    switch (key) {
      case 'not_requested':
      case 'not requested':
        return 'not_requested';
      case 'pending':
      case 'pending review':
        return 'pending';
      case 'approved':
        return 'approved';
      case 'rejected':
        return 'rejected';
      case 'paid':
        return 'paid';
      default:
        break;
    }
  }
  if (reimbursementRequired === false) return 'not_requested';
  if (reimbursementRequired === true) return 'pending';
  return 'not_requested';
}
