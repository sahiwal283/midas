/**
 * Post-push verification that Zoho stored the accounts Midas actually sent.
 *
 * The Zoho Integration Service can be configured (per brand, in its own
 * `zoho_products.extra_config`) to overwrite `account_id` / `paid_through_account_id`
 * on every expense it forwards. When those configured ids belong to a different
 * Zoho org the push fails outright; when they belong to the same org it *succeeds*
 * and silently books the expense against the wrong accounts. Midas cannot read that
 * config, so the only way to notice is to read the created record back and compare.
 */

/** Prefix on `zoho_sync_error` for a record that posted but with different accounts. */
export const MAPPING_WARNING_PREFIX = 'MAPPING_WARNING';

export interface PostedAccounts {
  accountId: string | null;
  paidThroughAccountId: string | null;
}

export interface AccountMismatch {
  field: 'account_id' | 'paid_through_account_id';
  sent: string | null;
  stored: string | null;
}

export interface AccountAuditResult {
  mismatched: boolean;
  mismatches: AccountMismatch[];
  /** Ready-to-store `zoho_sync_error` string, or null when everything matched. */
  warning: string | null;
}

const FIELD_LABELS: Record<AccountMismatch['field'], string> = {
  account_id: 'expense account',
  paid_through_account_id: 'paid-through account',
};

function compare(
  field: AccountMismatch['field'],
  sent: string | null | undefined,
  stored: string | null | undefined,
): AccountMismatch | null {
  const sentValue = sent?.trim() || null;
  const storedValue = stored?.trim() || null;
  // Nothing sent means Midas expressed no preference — Zoho's value is not a mismatch.
  if (!sentValue) return null;
  // Nothing read back means the readback was incomplete, not that a value was changed.
  if (!storedValue) return null;
  if (sentValue === storedValue) return null;
  return { field, sent: sentValue, stored: storedValue };
}

/**
 * Compares what Midas sent against what Zoho stored. Best-effort by design: a
 * missing value on either side is treated as "cannot tell", never as a mismatch,
 * so this can never turn a healthy push into a false alarm.
 */
export function auditPostedAccounts(
  sent: PostedAccounts,
  stored: PostedAccounts | null,
): AccountAuditResult {
  if (!stored) return { mismatched: false, mismatches: [], warning: null };

  const mismatches = [
    compare('account_id', sent.accountId, stored.accountId),
    compare('paid_through_account_id', sent.paidThroughAccountId, stored.paidThroughAccountId),
  ].filter((m): m is AccountMismatch => m !== null);

  if (mismatches.length === 0) return { mismatched: false, mismatches: [], warning: null };

  const detail = mismatches
    .map((m) => `${FIELD_LABELS[m.field]} sent ${m.sent} but Zoho stored ${m.stored}`)
    .join('; ');

  return {
    mismatched: true,
    mismatches,
    warning:
      `[${MAPPING_WARNING_PREFIX}] Posted to Zoho with different accounts than Midas sent — ${detail}. `
      + 'The Zoho Integration Service is overriding accounts for this brand; ask the integration team '
      + 'to clear expense_account_id / paid_through_account_id from the brand config.',
  };
}
