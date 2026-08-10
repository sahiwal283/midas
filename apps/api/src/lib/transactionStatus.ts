/** Map between legacy expense_status and transaction_status + integration_status. */

export type LegacyExpenseStatus =
  | 'draft'
  | 'pending'
  | 'in_review'
  | 'awaiting_info'
  | 'approved'
  | 'zoho_sync_failed'
  | 'rejected'
  | 'cancelled';

export type TransactionStatus =
  | 'draft'
  | 'submitted'
  | 'in_review'
  | 'awaiting_info'
  | 'approved'
  | 'rejected'
  | 'cancelled';

export type IntegrationStatus =
  | 'not_required'
  | 'pending'
  | 'queued'
  | 'syncing'
  | 'synced'
  | 'failed';

export function expenseStatusToTransactionStatus(status: LegacyExpenseStatus): TransactionStatus {
  switch (status) {
    case 'draft':
      return 'draft';
    case 'pending':
      return 'submitted';
    case 'in_review':
      return 'in_review';
    case 'awaiting_info':
      return 'awaiting_info';
    case 'approved':
      return 'approved';
    case 'zoho_sync_failed':
      return 'approved';
    case 'rejected':
      return 'rejected';
    case 'cancelled':
      return 'cancelled';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function transactionStatusToExpenseStatus(
  status: TransactionStatus,
  integration: IntegrationStatus,
): LegacyExpenseStatus {
  if (status === 'approved' && integration === 'failed') return 'zoho_sync_failed';
  switch (status) {
    case 'draft':
      return 'draft';
    case 'submitted':
      return 'pending';
    case 'in_review':
      return 'in_review';
    case 'awaiting_info':
      return 'awaiting_info';
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    case 'cancelled':
      return 'cancelled';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/** Derive integration status from Zoho linkage / entity / legacy failed status. */
export function deriveIntegrationStatus(input: {
  zohoRecordId: string | null | undefined;
  zohoEntity: string | null | undefined;
  legacyStatus?: LegacyExpenseStatus;
  zohoEnabled?: boolean;
}): IntegrationStatus {
  if (input.zohoRecordId) return 'synced';
  if (input.legacyStatus === 'zoho_sync_failed') return 'failed';
  if (input.zohoEnabled === false) return 'not_required';
  if (input.zohoEntity) return 'pending';
  return 'not_required';
}

/** Wire status for EXT / older clients that still understand zoho_sync_failed. */
export function toWireExpenseStatus(
  status: LegacyExpenseStatus,
  integration: IntegrationStatus,
): LegacyExpenseStatus {
  if (status === 'approved' && integration === 'failed') return 'zoho_sync_failed';
  if (status === 'zoho_sync_failed') return 'zoho_sync_failed';
  return status;
}
