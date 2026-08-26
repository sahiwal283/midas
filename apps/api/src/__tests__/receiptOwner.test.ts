import { describe, expect, it } from 'vitest';
import { resolveReceiptOwner, receiptOwnerValues } from '../lib/receiptOwner';

describe('resolveReceiptOwner', () => {
  it('resolves an expense-scoped route', () => {
    expect(resolveReceiptOwner({ expenseId: 'e1' })).toEqual({ kind: 'expense', id: 'e1' });
  });

  it('resolves a transaction-scoped route', () => {
    expect(resolveReceiptOwner({ transactionId: 't1' })).toEqual({ kind: 'transaction', id: 't1' });
  });

  it('refuses when neither owner is present', () => {
    expect(() => resolveReceiptOwner({})).toThrow(/owner/i);
  });

  it('refuses when both owners are present — the ambiguity the CHECK exists to prevent', () => {
    expect(() => resolveReceiptOwner({ expenseId: 'e1', transactionId: 't1' }))
      .toThrow(/owner/i);
  });

  it('carries a 400 status and code', () => {
    try {
      resolveReceiptOwner({});
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toMatchObject({ statusCode: 400, code: 'INVALID_RECEIPT_OWNER' });
    }
  });
});

describe('receiptOwnerValues', () => {
  it('sets only the expense column', () => {
    expect(receiptOwnerValues({ kind: 'expense', id: 'e1' }))
      .toEqual({ expenseId: 'e1', transactionId: null });
  });

  it('sets only the transaction column', () => {
    expect(receiptOwnerValues({ kind: 'transaction', id: 't1' }))
      .toEqual({ expenseId: null, transactionId: 't1' });
  });
});
