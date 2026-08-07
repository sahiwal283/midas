import { describe, expect, it } from 'vitest';
import { parseQueueFilters, partitionBulkReview } from '../lib/queueFilters';

describe('parseQueueFilters', () => {
  it('parses valid params and drops invalid ones', () => {
    const f = parseQueueFilters({
      search: '  amazon ', amountMin: '10', amountMax: 'abc',
      from: '2026-01-01', to: 'not-a-date', zohoStatus: 'synced',
      missingReceipt: 'true', ocrNeedsReview: '1', missingCategory: 'false',
    });
    expect(f).toEqual({
      search: 'amazon', amountMin: 10, from: '2026-01-01',
      zohoStatus: 'synced', missingReceipt: true, ocrNeedsReview: true,
    });
  });

  it('empty query → empty filters', () => {
    expect(parseQueueFilters({})).toEqual({});
  });

  it('rejects unknown zohoStatus', () => {
    expect(parseQueueFilters({ zohoStatus: 'weird' })).toEqual({});
  });
});

describe('partitionBulkReview', () => {
  const rows = [
    { id: 'a', status: 'pending' },
    { id: 'b', status: 'in_review' },
    { id: 'c', status: 'approved' },
    { id: 'd', status: 'awaiting_info' },
  ];

  it('approves only pending/in_review; skips the rest with reasons', () => {
    const r = partitionBulkReview(rows, ['a', 'b', 'c', 'd', 'e']);
    expect(r.approvable).toEqual(['a', 'b']);
    expect(r.skipped).toEqual([
      { id: 'c', reason: "not reviewable from status 'approved'" },
      { id: 'd', reason: "not reviewable from status 'awaiting_info'" },
      { id: 'e', reason: 'not found' },
    ]);
  });
});
