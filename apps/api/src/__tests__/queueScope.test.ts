import { describe, it, expect } from 'vitest';
import { parseQueueScope, isDailyExpense } from '../lib/queueScope';

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
