import { isZohoAccountId } from '@midas/shared';

export interface FlagsInput {
  sourceApp: string | null;
  categoryId: string | null;
  /** Live Zoho expense COA account_id (general/daily expenses). */
  zohoExpenseAccountId?: string | null;
  paymentMethodId: string | null;
  receipts?: { id: string }[];
  zohoEntity: string | null;
  zohoExpenseId: string | null;
  reimbursementStatus: string;
  status: string;
  /**
   * Whether the expense's company posts to Zoho at all. Undefined means unknown,
   * which is treated as enabled so callers that cannot supply it keep today's
   * behaviour. `false` is what suppresses ready_for_zoho — a Summitt Labs
   * expense is complete and correct, it simply has nowhere to be pushed.
   */
  companyZohoEnabled?: boolean;
  /**
   * Payment method with its Zoho paid-through mapping, when the caller loaded
   * the relation. An unmapped card cannot push (MISSING_ZOHO_PAID_THROUGH), so
   * it must not read as ready. Undefined (relation not loaded) keeps legacy
   * behaviour, exactly like companyZohoEnabled.
   */
  paymentMethod?: { zohoAccountName: string | null } | null;
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
  // Expense account = Midas category (Trade Show) OR live Zoho COA pick (daily).
  const hasExpenseAccount = !!(row.categoryId || row.zohoExpenseAccountId);
  if (!hasExpenseAccount) flags.push('needs_category');
  if ((row.receipts?.length ?? 0) === 0) flags.push('missing_receipt');
  if (!row.paymentMethodId) flags.push('needs_payment_method');
  if (row.status === 'approved' && !row.zohoEntity) flags.push('needs_entity');
  if (row.reimbursementStatus === 'pending') flags.push('reimbursement_pending');
  if (row.zohoExpenseId || (row as FlagsInput & { integrationStatus?: string }).integrationStatus === 'synced') {
    flags.push('zoho_synced');
  }

  const integrationFailed = (row as FlagsInput & { integrationStatus?: string }).integrationStatus === 'failed';
  const zohoReady =
    (row.status === 'approved' || row.status === 'zoho_sync_failed' || integrationFailed) &&
    row.companyZohoEnabled !== false &&
    !!row.zohoEntity &&
    !row.zohoExpenseId &&
    hasExpenseAccount &&
    !!row.paymentMethodId &&
    // A label in zoho_account_name is not a usable paid-through mapping — the push
    // would fail MISSING_ZOHO_PAID_THROUGH, so it must not read as ready here.
    (row.paymentMethod === undefined || isZohoAccountId(row.paymentMethod?.zohoAccountName)) &&
    (row.receipts?.length ?? 0) > 0;
  if (zohoReady) flags.push('ready_for_zoho');

  return flags;
}
