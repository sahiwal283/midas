import { describe, expect, it } from 'vitest';
import { migrateQueueItem } from './uploadQueue';

const payload = { merchant: 'Acme', amount: 12.5, date: '2026-09-11', currency: 'USD' };
const oneFile = { name: 'a.jpg', type: 'image/jpeg', size: 3, data: new ArrayBuffer(3) };

describe('migrateQueueItem', () => {
  it('rewrites a v1 single-receipt row into the v2 array shape', () => {
    const v1 = {
      id: 'i1', clientKey: 'k1', createdAt: 1, updatedAt: 1,
      status: 'pending', retryCount: 0, payload, receipt: oneFile,
    };
    const out = migrateQueueItem(v1)!;
    expect(out.receipts).toHaveLength(1);
    expect(out.receipts[0].name).toBe('a.jpg');
    expect(out.uploadedIndexes).toEqual([]);
    expect('receipt' in out).toBe(false);
  });

  it('carries a v1 expenseId across, so a partial sync is not repeated', () => {
    const v1 = {
      id: 'i1', clientKey: 'k1', createdAt: 1, updatedAt: 1,
      status: 'failed', retryCount: 2, payload, receipt: oneFile, expenseId: 'e1',
    };
    expect(migrateQueueItem(v1)!.expenseId).toBe('e1');
  });

  it('leaves an already-migrated v2 row alone', () => {
    const v2 = {
      id: 'i1', clientKey: 'k1', createdAt: 1, updatedAt: 1,
      status: 'pending', retryCount: 0, payload,
      receipts: [oneFile, oneFile], uploadedIndexes: [0],
    };
    const out = migrateQueueItem(v2)!;
    expect(out.receipts).toHaveLength(2);
    expect(out.uploadedIndexes).toEqual([0]);
  });

  it('discards a row with no files at all rather than syncing an empty expense', () => {
    expect(migrateQueueItem({ id: 'i1', payload })).toBeNull();
    expect(migrateQueueItem(null)).toBeNull();
  });
});
