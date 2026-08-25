/**
 * Zoho Books account ids are long numeric strings (e.g. "4849689000010206091").
 *
 * `payment_methods.zoho_account_name` historically held either a real account id
 * or a free-text label ("Corporate AMEX", "Employee Reimbursements"). Only an id
 * can be sent to Zoho as `paid_through_account_id`, so readiness checks and the
 * push payload must agree on what counts as mapped — a label is NOT a mapping.
 */

/** Minimum digits in a Zoho Books account id — labels never reach this length. */
export const ZOHO_ACCOUNT_ID_MIN_DIGITS = 10;

const ZOHO_ACCOUNT_ID_RE = new RegExp(`^\\d{${ZOHO_ACCOUNT_ID_MIN_DIGITS},}$`);

/** Returns the trimmed Zoho account id, or null when the value is a label. */
export function resolveZohoAccountId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return ZOHO_ACCOUNT_ID_RE.test(trimmed) ? trimmed : null;
}

/** True when the value is usable as a Zoho account id. */
export function isZohoAccountId(raw: string | null | undefined): boolean {
  return resolveZohoAccountId(raw) !== null;
}
