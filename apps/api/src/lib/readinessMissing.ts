// Pure (no env/db) so the DB-free test suite can import it. zohoReadiness.ts builds `missing` from these.
/**
 * The `missing` strings a submitter can fix by editing their own expense.
 * Defined here, next to where `missing` is built, so the two cannot drift.
 * Everything else (approval, submitter, Zoho paid-through mapping, open
 * accountant requests) is not the submitter's to supply.
 */
export const MISSING_MERCHANT = 'merchant name';
export const MISSING_AMOUNT = 'valid amount';
export const MISSING_DATE = 'expense date';
export const MISSING_EXPENSE_ACCOUNT = 'expense account (Zoho COA or category)';
export const MISSING_PAYMENT_METHOD = 'payment method';
export const MISSING_ENTITY = 'accounting entity (zohoEntity)';
export const MISSING_RECEIPT = 'receipt attachment';
export const SUBMITTER_FIXABLE_MISSING: readonly string[] = [
  MISSING_MERCHANT, MISSING_AMOUNT, MISSING_DATE, MISSING_EXPENSE_ACCOUNT,
  MISSING_PAYMENT_METHOD, MISSING_ENTITY, MISSING_RECEIPT,
];
