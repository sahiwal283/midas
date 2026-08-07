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

  it('never eligible when the company has Zoho disabled', () => {
    expect(isAutoPushEligible({ sourceApp: null, ready: true, companyZohoEnabled: false })).toBe(false);
  });

  it('companyZohoEnabled true or unknown keeps existing behavior', () => {
    expect(isAutoPushEligible({ sourceApp: null, ready: true, companyZohoEnabled: true })).toBe(true);
    expect(isAutoPushEligible({ sourceApp: null, ready: true, companyZohoEnabled: undefined })).toBe(true);
  });
});
