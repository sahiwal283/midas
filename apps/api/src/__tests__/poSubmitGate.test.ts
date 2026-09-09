import { describe, expect, it } from 'vitest';
import { poSubmitBlocker } from '../lib/poSubmitGate';

const READY = {
  vendorName: 'Acme Expo',
  zohoEnabled: true,
  zohoVendorId: 'v-1',
  lineItems: [{ zohoItemId: 'i-1' }, { zohoItemId: 'i-2' }],
};

describe('poSubmitBlocker', () => {
  it('lets a fully-mapped purchase order through', () => {
    expect(poSubmitBlocker(READY)).toBeNull();
  });

  it('blocks a purchase order with no line items', () => {
    expect(poSubmitBlocker({ ...READY, lineItems: [] })?.code).toBe('MISSING_LINE_ITEMS');
  });

  it('blocks an empty vendor name left over from a draft', () => {
    expect(poSubmitBlocker({ ...READY, vendorName: '' })?.code).toBe('MISSING_VENDOR');
    expect(poSubmitBlocker({ ...READY, vendorName: '   ' })?.code).toBe('MISSING_VENDOR');
  });

  it('blocks a missing Zoho vendor when the company posts to Zoho', () => {
    expect(poSubmitBlocker({ ...READY, zohoVendorId: null })?.code).toBe('MISSING_ZOHO_VENDOR');
  });

  it('blocks a line with no Zoho item when the company posts to Zoho', () => {
    const blocker = poSubmitBlocker({
      ...READY,
      lineItems: [{ zohoItemId: 'i-1' }, { zohoItemId: null }],
    });
    expect(blocker?.code).toBe('MISSING_ZOHO_ITEM');
  });

  it('reports the line-item block before the Zoho blocks', () => {
    const blocker = poSubmitBlocker({
      vendorName: '', zohoEnabled: true, zohoVendorId: null, lineItems: [],
    });
    expect(blocker?.code).toBe('MISSING_LINE_ITEMS');
  });

  it('skips the Zoho checks when the company does not post to Zoho', () => {
    expect(poSubmitBlocker({
      ...READY, zohoEnabled: false, zohoVendorId: null, lineItems: [{ zohoItemId: null }],
    })).toBeNull();
  });

  it('still requires a vendor name when Zoho is off', () => {
    expect(poSubmitBlocker({
      ...READY, zohoEnabled: false, vendorName: '',
    })?.code).toBe('MISSING_VENDOR');
  });

  it('returns 409 for every blocker, since none is a malformed request', () => {
    const blockers = [
      poSubmitBlocker({ ...READY, lineItems: [] }),
      poSubmitBlocker({ ...READY, vendorName: '' }),
      poSubmitBlocker({ ...READY, zohoVendorId: null }),
      poSubmitBlocker({ ...READY, lineItems: [{ zohoItemId: null }] }),
    ];
    expect(blockers.every((b) => b?.status === 409)).toBe(true);
  });

  it('explains what to do, not just what is wrong', () => {
    expect(poSubmitBlocker({ ...READY, lineItems: [{ zohoItemId: null }] })?.message)
      .toContain('Zoho item');
  });
});
