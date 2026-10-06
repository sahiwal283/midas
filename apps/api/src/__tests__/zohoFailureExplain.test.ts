import { describe, expect, it } from 'vitest';
import { explainZohoFailure, expenseAccountSource, type ZohoFailureContext } from '../lib/zohoFailureExplain';

const ctx: ZohoFailureContext = {
  company: 'Boomin Brands',
  categoryName: 'Equipment',
  paymentMethodLabel: 'Boomin Capital One ···9330',
  accountSource: 'company_map',
};

describe('expenseAccountSource', () => {
  it('names where the account id Midas sent came from, in payload order', () => {
    expect(expenseAccountSource({ pinned: 'a', resolved: 'a', legacy: 'c' })).toBe('company_map');
    expect(expenseAccountSource({ pinned: 'a', resolved: 'b', legacy: 'c' })).toBe('stale_pin');
    expect(expenseAccountSource({ pinned: 'a', resolved: null, legacy: 'c' })).toBe('pinned');
    expect(expenseAccountSource({ pinned: null, resolved: 'b', legacy: 'c' })).toBe('company_map');
    // The resolution falls back to the legacy column itself when no company row exists.
    expect(expenseAccountSource({ pinned: null, resolved: 'c', legacy: 'c' })).toBe('legacy');
    expect(expenseAccountSource({ pinned: 'c', resolved: 'c', legacy: 'c' })).toBe('legacy');
  });
});

describe('explainZohoFailure', () => {
  // Prod showed accountants "[MAPPING_ERROR] Please enter valid expense
  // account" on an expense whose category was plainly set. The category was
  // never the problem — the Zoho account behind it was — and nothing said so.
  it('says the category is set and the Zoho account behind it is what was rejected', () => {
    const msg = explainZohoFailure('MAPPING_ERROR', 'Please enter valid expense account', ctx);
    expect(msg).toContain('The category "Equipment" is set');
    expect(msg).toContain('Boomin Brands');
    expect(msg).toContain('Settings → Chart of Accounts');
    expect(msg).toContain('(Zoho said: "Please enter valid expense account")');
  });

  it('a missing company mapping is named as such', () => {
    const msg = explainZohoFailure('MAPPING_ERROR', 'Please enter valid expense account', { ...ctx, accountSource: 'legacy' });
    expect(msg).toContain('is not attached to a Boomin Brands account');
  });

  it('a stale account kept on the expense tells the accountant to re-pick the category', () => {
    const msg = explainZohoFailure('MAPPING_ERROR', 'Please enter valid expense account', { ...ctx, accountSource: 'stale_pin' });
    expect(msg).toContain('still carries an older account');
  });

  it('a paid-through rejection points at the payment method, not the category', () => {
    const msg = explainZohoFailure('MAPPING_ERROR', 'Please enter valid paid through account', ctx);
    expect(msg).toContain('payment method "Boomin Capital One ···9330"');
    expect(msg).toContain('Settings → Payment Methods');
    expect(msg).not.toContain('Chart of Accounts');
  });

  it('leaves every other failure as Zoho worded it', () => {
    expect(explainZohoFailure('VALIDATION_ERROR', 'amount must be positive', ctx)).toBe('amount must be positive');
    expect(explainZohoFailure('MAPPING_ERROR', 'Unknown brand', ctx)).toBe('Unknown brand');
    expect(explainZohoFailure('NETWORK_ERROR', 'fetch failed', ctx)).toBe('fetch failed');
  });
});
