import { describe, it, expect } from 'vitest';
import { mapTradeShowRole, cleanZohoAccountId, ENTITY_COMPANY_MAP } from '../lib/tradeshowSync';

describe('mapTradeShowRole', () => {
  it('maps 1:1 roles through', () => {
    expect(mapTradeShowRole('developer')).toBe('developer');
    expect(mapTradeShowRole('admin')).toBe('admin');
    expect(mapTradeShowRole('accountant')).toBe('accountant');
  });
  it('maps salesperson and coordinator to user (user decision 2026-08-10)', () => {
    expect(mapTradeShowRole('salesperson')).toBe('user');
    expect(mapTradeShowRole('coordinator')).toBe('user');
  });
  it('throws on unknown roles rather than guessing', () => {
    expect(() => mapTradeShowRole('pending')).toThrow();
    expect(() => mapTradeShowRole('temporary')).toThrow();
  });
});

describe('cleanZohoAccountId', () => {
  it('passes clean numeric ids through', () => {
    expect(cleanZohoAccountId('5254962000000091172')).toBe('5254962000000091172');
  });
  it('extracts the numeric id from polluted "Haute: 525..." values', () => {
    expect(cleanZohoAccountId('Haute: 5254962000000000460')).toBe('5254962000000000460');
    expect(cleanZohoAccountId('Boomin: 4849689000000000442')).toBe('4849689000000000442');
  });
  it('returns null when no long numeric id is present', () => {
    expect(cleanZohoAccountId('n/a')).toBeNull();
    expect(cleanZohoAccountId('')).toBeNull();
  });
});

describe('ENTITY_COMPANY_MAP', () => {
  it('maps trade show entity slugs to Midas company names', () => {
    expect(ENTITY_COMPANY_MAP.haute_brands).toBe('Haute Brands');
    expect(ENTITY_COMPANY_MAP.boomin_brands).toBe('Boomin Brands');
    expect(ENTITY_COMPANY_MAP.nirvana_kulture).toBe('Nirvana Kulture');
  });
});
