import { describe, it, expect } from 'vitest';
import { parseQueueScope, requireQueueScope, isDailyExpense } from '../lib/queueScope';

describe('parseQueueScope', () => {
  it('accepts the two valid scopes', () => {
    expect(parseQueueScope('event')).toBe('event');
    expect(parseQueueScope('daily')).toBe('daily');
  });
  it('ignores anything else rather than guessing', () => {
    expect(parseQueueScope(undefined)).toBeUndefined();
    expect(parseQueueScope('')).toBeUndefined();
    expect(parseQueueScope('EVENT')).toBeUndefined();
    expect(parseQueueScope('all')).toBeUndefined();
  });
});

describe('requireQueueScope', () => {
  it('accepts the two valid scopes', () => {
    expect(requireQueueScope('event')).toBe('event');
    expect(requireQueueScope('daily')).toBe('daily');
  });
  it('treats an absent scope as unscoped, exactly like parseQueueScope', () => {
    expect(requireQueueScope(undefined)).toBeUndefined();
  });
  it('fails closed on a present-but-unrecognised value instead of dropping the filter', () => {
    expect(() => requireQueueScope('EVENT')).toThrow(/scope/i);
    expect(() => requireQueueScope('all')).toThrow(/scope/i);
    expect(() => requireQueueScope('')).toThrow(/scope/i);
  });
  it('fails closed on a non-string value (e.g. a repeated ?scope= query param)', () => {
    expect(() => requireQueueScope(['event', 'daily'])).toThrow(/scope/i);
    expect(() => requireQueueScope({})).toThrow(/scope/i);
  });
  it('rejections are 400s with a stable error code', () => {
    try {
      requireQueueScope('Daily');
      expect.unreachable();
    } catch (err) {
      expect((err as { statusCode?: number }).statusCode).toBe(400);
      expect((err as { code?: string }).code).toBe('INVALID_SCOPE');
    }
  });
});

describe('isDailyExpense', () => {
  it('treats Midas-native and browser-extension expenses as daily', () => {
    expect(isDailyExpense({ sourceApp: null })).toBe(true);
    expect(isDailyExpense({ sourceApp: 'browser_extension' })).toBe(true);
  });
  it('treats external app expenses as event', () => {
    expect(isDailyExpense({ sourceApp: 'trade_show' })).toBe(false);
    expect(isDailyExpense({ sourceApp: 'argo' })).toBe(false);
  });
  it('is a total split — every expense is daily or event, never both or neither', () => {
    for (const sourceApp of [null, 'browser_extension', 'trade_show', 'argo', '']) {
      const daily = isDailyExpense({ sourceApp });
      expect(typeof daily).toBe('boolean');
    }
  });
});
