// Which record a receipt belongs to.
//
// A receipt hangs from an expense or from a purchase-order transaction, never
// both and never neither. The database enforces that with a CHECK constraint;
// this resolves the route's params to the same rule before we ever reach it,
// so the failure is a 400 with a useful message rather than a 500 from
// Postgres.

import type { AppError } from '../middleware/error';

export type ReceiptOwnerKind = 'expense' | 'transaction';

export interface ReceiptOwnerRef {
  kind: ReceiptOwnerKind;
  id: string;
}

function invalidOwner(message: string): AppError {
  const err = new Error(message) as AppError;
  err.statusCode = 400;
  err.code = 'INVALID_RECEIPT_OWNER';
  return err;
}

/** Turn whichever route param is present into the receipt's owner. */
export function resolveReceiptOwner(params: {
  expenseId?: string;
  transactionId?: string;
}): ReceiptOwnerRef {
  const { expenseId, transactionId } = params;
  if (expenseId && transactionId) {
    throw invalidOwner('Receipt owner cannot be both expense and transaction');
  }
  if (expenseId) return { kind: 'expense', id: expenseId };
  if (transactionId) return { kind: 'transaction', id: transactionId };
  throw invalidOwner('A receipt needs an owner: no expense or transaction in the route');
}

/** Column values for an insert — the unused owner column is explicitly null. */
export function receiptOwnerValues(owner: ReceiptOwnerRef): {
  expenseId: string | null;
  transactionId: string | null;
} {
  return owner.kind === 'expense'
    ? { expenseId: owner.id, transactionId: null }
    : { expenseId: null, transactionId: owner.id };
}
