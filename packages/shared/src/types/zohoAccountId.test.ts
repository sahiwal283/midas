import { describe, it, expect } from 'vitest';
import { resolveZohoAccountId, isZohoAccountId } from './zohoAccountId';

describe('resolveZohoAccountId', () => {
  it('accepts a real Zoho Books account id', () => {
    expect(resolveZohoAccountId('4849689000010206091')).toBe('4849689000010206091');
  });

  it('trims surrounding whitespace', () => {
    expect(resolveZohoAccountId('  4849689000010206091  ')).toBe('4849689000010206091');
  });

  it('rejects free-text labels stored in the same column', () => {
    expect(resolveZohoAccountId('Corporate AMEX')).toBeNull();
    expect(resolveZohoAccountId('Employee Reimbursements')).toBeNull();
    expect(resolveZohoAccountId('AMEX-1234')).toBeNull();
  });

  it('rejects numbers too short to be account ids', () => {
    expect(resolveZohoAccountId('1234')).toBeNull();
    expect(resolveZohoAccountId('123456789')).toBeNull();
  });

  it('accepts exactly the minimum digit count', () => {
    expect(resolveZohoAccountId('1234567890')).toBe('1234567890');
  });

  it('rejects ids with non-digit characters', () => {
    expect(resolveZohoAccountId('48496890000102060 91')).toBeNull();
    expect(resolveZohoAccountId('4849689000010206091x')).toBeNull();
  });

  it('returns null for empty and nullish input', () => {
    expect(resolveZohoAccountId(null)).toBeNull();
    expect(resolveZohoAccountId(undefined)).toBeNull();
    expect(resolveZohoAccountId('')).toBeNull();
    expect(resolveZohoAccountId('   ')).toBeNull();
  });
});

describe('isZohoAccountId', () => {
  it('mirrors resolveZohoAccountId as a boolean', () => {
    expect(isZohoAccountId('4849689000010206091')).toBe(true);
    expect(isZohoAccountId('Corporate AMEX')).toBe(false);
    expect(isZohoAccountId(null)).toBe(false);
  });
});
