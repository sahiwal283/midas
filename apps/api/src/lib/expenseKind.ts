export type ExpenseKind = 'business' | 'partner';

/**
 * Only the partner role may record partner spend. Developer passes every role
 * gate in the app (see lib/roles.ts), so it is allowed too. Anything else — an
 * unknown value, or a non-partner asking for partner — resolves to business.
 * The client is never trusted with this field.
 */
export function resolveExpenseKind(
  requestedKind: string | null | undefined,
  role: string,
): ExpenseKind {
  if (requestedKind !== 'partner') return 'business';
  return role === 'partner' || role === 'developer' ? 'partner' : 'business';
}

/** Partner spend is excluded from the accountant queue and the Zoho pipeline. */
export function isPartnerExpense(e: { expenseKind?: string | null }): boolean {
  return e.expenseKind === 'partner';
}
