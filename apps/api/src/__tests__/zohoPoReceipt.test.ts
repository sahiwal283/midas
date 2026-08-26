import { describe, expect, it } from 'vitest';
import { poReceiptWarning, shouldAttemptPoReceiptAttach } from '../lib/zohoPoReceipt';

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
