import { describe, expect, it } from 'vitest';
import { granularityFor, periodKey, periodLabel, listPeriods, fillPeriods } from '../lib/reportBuckets';

describe('granularityFor', () => {
  it('week for spans ≤ 62 days, month above', () => {
    expect(granularityFor('2026-01-01', '2026-02-28')).toBe('week');
    expect(granularityFor('2026-01-01', '2026-03-15')).toBe('month');
  });
});

describe('periodKey', () => {
  it('month keys', () => {
    expect(periodKey('2026-03-09', 'month')).toBe('2026-03');
  });
  it('ISO week keys (Monday start, ISO year)', () => {
    expect(periodKey('2026-03-09', 'week')).toBe('2026-W11');
    expect(periodKey('2026-01-01', 'week')).toBe('2026-W01');
    expect(periodKey('2027-01-01', 'week')).toBe('2026-W53'); // 2027-01-01 falls in ISO week 53 of 2026
  });
});

describe('periodLabel', () => {
  it('labels months and weeks', () => {
    expect(periodLabel('2026-03')).toBe('Mar 2026');
    expect(periodLabel('2026-W11')).toBe('Wk of Mar 9');
  });
});

describe('listPeriods / fillPeriods', () => {
  it('lists contiguous months across a year boundary', () => {
    expect(listPeriods('2025-11-15', '2026-02-10', 'month')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });
  it('zero-fills gaps', () => {
    const rows = new Map([['2025-12', { spend: 100, count: 2 }]]);
    const out = fillPeriods('2025-11-15', '2026-01-20', 'month', rows);
    expect(out.map((p) => p.spend)).toEqual([0, 100, 0]);
    expect(out[1]).toMatchObject({ period: '2025-12', label: 'Dec 2025' });
  });
  it('lists contiguous ISO weeks', () => {
    expect(listPeriods('2026-03-02', '2026-03-20', 'week')).toEqual(['2026-W10', '2026-W11', '2026-W12']);
  });
});
