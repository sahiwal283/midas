import { describe, it, expect } from 'vitest';
import { findDuplicateMatches, duplicateDateWindow } from '../lib/ext/extWarnings';

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

describe('duplicateDateWindow', () => {
  it('spans exactly 3 days on each side of the candidate date, inclusive', () => {
    expect(duplicateDateWindow('2026-08-10')).toEqual({ from: '2026-08-07', to: '2026-08-13' });
  });

  it('includes a row exactly 3 days earlier as a match against the window bounds', () => {
    const { from } = duplicateDateWindow(candidate.date);
    expect(findDuplicateMatches(candidate, [
      { id: 'e1', merchant: 'Starbucks', amount: '12.50', date: from },
    ])).toHaveLength(1);
  });

  it('includes a row exactly 3 days later as a match against the window bounds', () => {
    const { to } = duplicateDateWindow(candidate.date);
    expect(findDuplicateMatches(candidate, [
      { id: 'e1', merchant: 'Starbucks', amount: '12.50', date: to },
    ])).toHaveLength(1);
  });

  it('excludes a row one day outside the window on each side', () => {
    const { from, to } = duplicateDateWindow(candidate.date);
    const dayBeforeFrom = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const dayAfterTo = new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    expect(findDuplicateMatches(candidate, [
      { id: 'e1', merchant: 'Starbucks', amount: '12.50', date: dayBeforeFrom },
      { id: 'e2', merchant: 'Starbucks', amount: '12.50', date: dayAfterTo },
    ])).toHaveLength(0);
  });

  it('handles year/month boundaries correctly', () => {
    expect(duplicateDateWindow('2026-01-01')).toEqual({ from: '2025-12-29', to: '2026-01-04' });
  });
});
