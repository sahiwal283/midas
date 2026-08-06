import { describe, expect, it } from 'vitest';
import { isAutoPushEligible } from '../lib/autoApprove';

describe('isAutoPushEligible', () => {
  it('eligible: Midas-entered (null source) and ready', () => {
    expect(isAutoPushEligible({ sourceApp: null, ready: true })).toBe(true);
  });
  it('eligible: browser extension and ready', () => {
    expect(isAutoPushEligible({ sourceApp: 'browser_extension', ready: true })).toBe(true);
  });
  it('not eligible when not ready', () => {
    expect(isAutoPushEligible({ sourceApp: null, ready: false })).toBe(false);
  });
  it('never eligible for trade_show or other external sources, even when ready', () => {
    expect(isAutoPushEligible({ sourceApp: 'trade_show', ready: true })).toBe(false);
    expect(isAutoPushEligible({ sourceApp: 'milo', ready: true })).toBe(false);
  });
});
