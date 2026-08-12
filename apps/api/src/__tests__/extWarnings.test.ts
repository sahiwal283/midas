import { describe, it, expect } from 'vitest';
import { findDuplicateMatches } from '../lib/ext/extWarnings';

const candidate = { merchant: 'Starbucks #123', amount: 12.5, date: '2026-08-10' };

describe('findDuplicateMatches', () => {
  it('matches on same amount, near date and similar merchant', () => {
    const m = findDuplicateMatches(candidate, [
      { id: 'e1', merchant: 'Starbucks', amount: '12.50', date: '2026-08-09' },
    ]);
    expect(m).toHaveLength(1);
    expect(m[0]).toEqual({ id: 'e1', merchant: 'Starbucks', amount: 12.5, date: '2026-08-09' });
  });

  it('ignores a different amount', () => {
    expect(findDuplicateMatches(candidate, [
      { id: 'e1', merchant: 'Starbucks', amount: '13.00', date: '2026-08-09' },
    ])).toHaveLength(0);
  });

  it('ignores a date more than three days away', () => {
    expect(findDuplicateMatches(candidate, [
      { id: 'e1', merchant: 'Starbucks', amount: '12.50', date: '2026-08-01' },
    ])).toHaveLength(0);
  });

  it('ignores an unrelated merchant', () => {
    expect(findDuplicateMatches(candidate, [
      { id: 'e1', merchant: 'Hilton Garden Inn', amount: '12.50', date: '2026-08-10' },
    ])).toHaveLength(0);
  });

  it('returns every match when there are several', () => {
    expect(findDuplicateMatches(candidate, [
      { id: 'e1', merchant: 'Starbucks', amount: '12.50', date: '2026-08-09' },
      { id: 'e2', merchant: 'starbucks #123', amount: '12.50', date: '2026-08-10' },
    ])).toHaveLength(2);
  });

  it('returns nothing for an empty candidate set', () => {
    expect(findDuplicateMatches(candidate, [])).toHaveLength(0);
  });
});
