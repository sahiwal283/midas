import { describe, it, expect } from 'vitest';
import { MockOcrAdapter } from '../adapters/mockAdapter';

describe('MockOcrAdapter', () => {
  it('returns a fully-shaped OcrResult with no network calls', async () => {
    const adapter = new MockOcrAdapter();
    const result = await adapter.process('/tmp/receipt.jpg', 'receipt-1');

    expect(result.provider).toBe('mock');
    expect(result.ledgerRecorded).toBe(false);
    expect(result.costEstimateUsd).toBeNull();
    expect(result.fields.merchant.value).toBeTruthy();
    expect(result.fields.amount.value).toBeTruthy();
  });
});
