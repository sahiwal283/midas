import { describe, expect, it } from 'vitest';
import {
  poReceiptProblem,
  poReceiptWarning,
  shouldAttemptPoReceiptAttach,
} from '../lib/zohoPoReceipt';

describe('poReceiptWarning', () => {
  it('is null when the receipt attached cleanly', () => {
    expect(poReceiptWarning(null)).toBeNull();
  });

  it('marks the PO without claiming the push failed', () => {
    const warning = poReceiptWarning('Zoho rejected the receipt upload');
    expect(warning).toBe('[RECEIPT_WARNING] Zoho rejected the receipt upload');
  });

  it('truncates to the zoho_sync_error column width', () => {
    const warning = poReceiptWarning('x'.repeat(600))!;
    expect(warning.length).toBeLessThanOrEqual(500);
    expect(warning.startsWith('[RECEIPT_WARNING] ')).toBe(true);
  });
});

describe('shouldAttemptPoReceiptAttach', () => {
  it('attempts the attach after a real, non-dry-run push', () => {
    expect(shouldAttemptPoReceiptAttach('ZBO-123', false)).toBe(true);
  });

  it('skips the attach on a dry run, even with a purchase order id', () => {
    expect(shouldAttemptPoReceiptAttach('DRY-RUN-PO-123', true)).toBe(false);
  });

  it('treats an undefined dryRun flag as a real push, not a dry run', () => {
    expect(shouldAttemptPoReceiptAttach('ZBO-123', undefined)).toBe(true);
  });

  it('skips the attach when there is no purchase order id', () => {
    expect(shouldAttemptPoReceiptAttach(null, false)).toBe(false);
    expect(shouldAttemptPoReceiptAttach(undefined, false)).toBe(false);
    expect(shouldAttemptPoReceiptAttach('', false)).toBe(false);
  });
});

describe('poReceiptProblem', () => {
  it('says nothing when the receipt attached', () => {
    expect(poReceiptProblem({ kind: 'attached' })).toBeNull();
  });

  it('flags a purchase order pushed with no receipt at all', () => {
    // Spec Decision 6. Without this a receipt-less PO rendered as a clean
    // "Created": there was no receipt to attach, so nothing was ever flagged,
    // and the expense-side missing_receipt flag cannot reach a PO because its
    // subquery keys on receipts.expense_id.
    expect(poReceiptProblem({ kind: 'none' })).toBe('purchase order pushed with no receipt');
  });

  it('flags a receipt Zoho refused', () => {
    expect(poReceiptProblem({ kind: 'rejected' })).toBe('Zoho rejected the receipt upload');
  });

  it('names the storage path when the file could not be read', () => {
    expect(poReceiptProblem({ kind: 'unreadable', storagePath: '2026/08/abc.jpg' }))
      .toBe('receipt file could not be read (2026/08/abc.jpg)');
  });

  it('turns every non-attached outcome into a warning, never a push failure', () => {
    // The warning prefix is what keeps the retry button hidden on the PO —
    // the Books record exists, so a re-push would duplicate it.
    for (const outcome of [
      { kind: 'none' } as const,
      { kind: 'rejected' } as const,
      { kind: 'unreadable', storagePath: 'x.pdf' } as const,
    ]) {
      const warning = poReceiptWarning(poReceiptProblem(outcome));
      expect(warning).toMatch(/^\[RECEIPT_WARNING] /);
    }
    expect(poReceiptWarning(poReceiptProblem({ kind: 'attached' }))).toBeNull();
  });
});
