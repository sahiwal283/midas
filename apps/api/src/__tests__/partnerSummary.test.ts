import { describe, it, expect } from 'vitest';
import { effectiveDateRange, summarisePartnerRows } from '../lib/partnerSummary';

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

describe('effectiveDateRange', () => {
  it('returns null when no range is given and there are no partner expenses to bound it', () => {
    expect(effectiveDateRange(undefined, undefined, { min: null, max: null })).toBeNull();
  });

  it('falls back to the min/max expense date when no range is given and rows exist', () => {
    expect(effectiveDateRange(undefined, undefined, { min: '2026-01-05', max: '2026-03-20' }))
      .toEqual({ from: '2026-01-05', to: '2026-03-20' });
  });

  it('uses the explicit range as-is, ignoring the bounds', () => {
    expect(effectiveDateRange('2026-02-01', '2026-02-28', { min: '2026-01-05', max: '2026-03-20' }))
      .toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });
});
