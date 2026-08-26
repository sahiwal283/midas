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

  it('accepts flag-derived lane params', () => {
    expect(parseQueueFilters({
      readyForZoho: 'true',
      missingEntity: '1',
      reimbursementOpen: 'true',
    })).toEqual({
      readyForZoho: true,
      missingEntity: true,
      reimbursementOpen: true,
    });
  });

  it('parses the event filter, trimming and dropping blanks', () => {
    expect(parseQueueFilters({ event: '  Champs Spring LV 2026 ' }))
      .toEqual({ event: 'Champs Spring LV 2026' });
    expect(parseQueueFilters({ event: '   ' })).toEqual({});
  });

  it('accepts the two valid scopes', () => {
    expect(parseQueueFilters({ scope: 'event' })).toEqual({ scope: 'event' });
    expect(parseQueueFilters({ scope: 'daily' })).toEqual({ scope: 'daily' });
  });

  it('leaves scope unset when absent (unscoped)', () => {
    expect(parseQueueFilters({})).toEqual({});
  });

  it('fails closed on a present-but-unrecognised scope instead of silently returning both scopes', () => {
    expect(() => parseQueueFilters({ scope: 'Daily' })).toThrow(/scope/i);
    expect(() => parseQueueFilters({ scope: 'all' })).toThrow(/scope/i);
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

  it('never approves partner-kind expenses, regardless of status', () => {
    const partnerRows = [
      { id: 'p1', status: 'pending', expenseKind: 'partner' },
      { id: 'p2', status: 'in_review', expenseKind: 'partner' },
      { id: 'b1', status: 'pending', expenseKind: 'business' },
    ];
    const r = partitionBulkReview(partnerRows, ['p1', 'p2', 'b1']);
    expect(r.approvable).toEqual(['b1']);
    expect(r.skipped).toEqual([
      { id: 'p1', reason: 'partner expenses are not reviewable' },
      { id: 'p2', reason: 'partner expenses are not reviewable' },
    ]);
  });
});
