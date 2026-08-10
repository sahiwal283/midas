/** Pure Zoho identity helpers (no env imports — safe for unit tests). */

export function buildPoIdempotencyKey(transactionId: string): string {
  return `midas-po-${transactionId}`;
}

export function buildExpenseIdempotencyKey(expenseId: string): string {
  return `midas-expense-${expenseId}`;
}
