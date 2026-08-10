import { describe, expect, it } from 'vitest';
import { PERIOD_RE, periodOf, isInClosedPeriods, closedPeriodMessage } from '../lib/closedPeriods';

describe('periodOf', () => {
  it('extracts YYYY-MM from a date', () => {
    expect(periodOf('2026-08-04')).toBe('2026-08');
    expect(periodOf('2025-12-31')).toBe('2025-12');
  });
});

describe('isInClosedPeriods', () => {
  it('matches when the month is closed', () => {
    expect(isInClosedPeriods('2026-07-15', ['2026-06', '2026-07'])).toBe(true);
  });

  it('does not match open months', () => {
    expect(isInClosedPeriods('2026-08-01', ['2026-06', '2026-07'])).toBe(false);
  });

  it('handles an empty closed list', () => {
    expect(isInClosedPeriods('2026-08-01', [])).toBe(false);
  });

  it('does not match adjacent years', () => {
    expect(isInClosedPeriods('2025-07-15', ['2026-07'])).toBe(false);
  });
});

describe('PERIOD_RE', () => {
  it('accepts valid YYYY-MM', () => {
    expect(PERIOD_RE.test('2026-01')).toBe(true);
    expect(PERIOD_RE.test('2026-12')).toBe(true);
  });

  it('rejects invalid months and formats', () => {
    expect(PERIOD_RE.test('2026-00')).toBe(false);
    expect(PERIOD_RE.test('2026-13')).toBe(false);
    expect(PERIOD_RE.test('2026-1')).toBe(false);
    expect(PERIOD_RE.test('2026-01-01')).toBe(false);
    expect(PERIOD_RE.test('202601')).toBe(false);
  });
});

describe('closedPeriodMessage', () => {
  it('names the period', () => {
    expect(closedPeriodMessage('2026-07'))
      .toBe('This expense falls in a closed accounting period (2026-07).');
  });
});
