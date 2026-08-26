import { describe, expect, it } from 'vitest';
import { poReceiptWarning } from '../lib/zohoPoReceipt';

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
