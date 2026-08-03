import { describe, it, expect } from 'vitest';
import { prepareReceiptImageForOcr } from '../preprocessing';

describe('prepareReceiptImageForOcr', () => {
  it('passes PDFs through unchanged (the OCR engine rasterizes PDFs itself)', async () => {
    const result = await prepareReceiptImageForOcr('/tmp/receipt.pdf');
    expect(result.pathForRequest).toBe('/tmp/receipt.pdf');
    expect(result.cleanup).toEqual([]);
  });
});
