import { describe, it, expect } from 'vitest';
import { summarisePartnerRows } from '../lib/partnerSummary';

describe('summarisePartnerRows', () => {
  it('groups by key, sums spend and counts, sorted by spend descending', () => {
    const rows = [
      { key: 'u1', spend: 50, count: 1 },
      { key: 'u2', spend: 120, count: 2 },
      { key: 'u1', spend: 30, count: 1 },
    ];
    expect(summarisePartnerRows(rows, (k) => ({ u1: 'Ada', u2: 'Grace' }[k] ?? k))).toEqual([
      { name: 'Grace', spend: 120, count: 2 },
      { name: 'Ada', spend: 80, count: 2 },
    ]);
  });

  it('labels a missing key as Unassigned rather than dropping the row', () => {
    expect(summarisePartnerRows([{ key: null, spend: 10, count: 1 }], () => 'x')).toEqual([
      { name: 'Unassigned', spend: 10, count: 1 },
    ]);
  });

  it('returns an empty array for no rows', () => {
    expect(summarisePartnerRows([], () => 'x')).toEqual([]);
  });
});
