export interface FlagsInput {
  sourceApp: string | null;
  categoryId: string | null;
  paymentMethodId: string | null;
  receipts?: { id: string }[];
  zohoEntity: string | null;
  zohoExpenseId: string | null;
  reimbursementStatus: string;
  status: string;
}

export type Flag =
  | 'from_extension'
  | 'needs_category'
  | 'missing_receipt'
  | 'needs_payment_method'
  | 'needs_entity'
  | 'reimbursement_pending'
  | 'zoho_synced'
  | 'ready_for_zoho';

/**
 * Derive attention flags from an already-fetched expense row.
 * Pure function — no DB access. All flags are computed, never stored.
 */
export function computeFlags(row: FlagsInput): Flag[] {
  const flags: Flag[] = [];

  if (row.sourceApp === 'browser_extension') flags.push('from_extension');
  if (!row.categoryId) flags.push('needs_category');
  if ((row.receipts?.length ?? 0) === 0) flags.push('missing_receipt');
  if (!row.paymentMethodId) flags.push('needs_payment_method');
  if (row.status === 'approved' && !row.zohoEntity) flags.push('needs_entity');
  if (row.reimbursementStatus === 'pending') flags.push('reimbursement_pending');
  if (row.zohoExpenseId) flags.push('zoho_synced');

  const zohoReady =
    row.status === 'approved' &&
    !!row.zohoEntity &&
    !row.zohoExpenseId &&
    !!row.categoryId &&
    !!row.paymentMethodId &&
    (row.receipts?.length ?? 0) > 0;
  if (zohoReady) flags.push('ready_for_zoho');

  return flags;
}
