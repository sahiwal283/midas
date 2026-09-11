import { describe, expect, it } from 'vitest';
import { bundleReceiptProblem } from '../lib/receiptBundle';

const file = { buffer: Buffer.from('x'), filename: 'receipt-2-pages.pdf', mimeType: 'application/pdf' };

describe('bundleReceiptProblem', () => {
  it('is null when the bundle attached cleanly', () => {
    expect(bundleReceiptProblem({ file, skipped: [] }, true)).toBeNull();
  });

  it('reports a Zoho rejection', () => {
    expect(bundleReceiptProblem({ file, skipped: [] }, false))
      .toBe('Zoho rejected the receipt upload');
  });

  it('names receipts left out of a bundle that did attach', () => {
    expect(bundleReceiptProblem({ file, skipped: ['old.webp'] }, true))
      .toBe('1 receipt not included in the attachment: old.webp');
  });

  it('pluralises and lists every excluded receipt', () => {
    expect(bundleReceiptProblem({ file, skipped: ['a.webp', 'b.webp'] }, true))
      .toBe('2 receipts not included in the attachment: a.webp, b.webp');
  });

  it('keeps the rejection when some receipts were also excluded', () => {
    expect(bundleReceiptProblem({ file, skipped: ['a.webp'] }, false))
      .toBe('Zoho rejected the receipt upload; 1 receipt not included in the attachment: a.webp');
  });

  it('distinguishes "nothing could be attached" from "there was no receipt"', () => {
    // file: null WITH skipped entries means receipts exist but none are
    // embeddable. That is a different fact from a receipt-less record, and an
    // accountant reading the warning has to be able to tell them apart.
    expect(bundleReceiptProblem({ file: null, skipped: ['a.webp'] }, false))
      .toBe('no receipt could be attached (unsupported file type: a.webp)');
  });

  it('is null for a genuinely receipt-less record', () => {
    // The caller decides what a receipt-less record means — on the expense side
    // nothing is warned, on the PO side poReceiptProblem({kind:'none'}) is used.
    expect(bundleReceiptProblem({ file: null, skipped: [] }, false)).toBeNull();
  });
});
