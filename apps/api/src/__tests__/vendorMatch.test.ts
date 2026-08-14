import { describe, expect, it } from 'vitest';
import { matchVendorByName } from '../lib/vendorMatch';

const vendors = [
  { id: 'v-1', name: 'S&D Supply' },
  { id: 'v-2', name: 'Uline ' },
  { id: 'v-3', name: 'Home Depot' },
];

describe('matchVendorByName', () => {
  it('matches exactly, ignoring case and surrounding whitespace', () => {
    expect(matchVendorByName(vendors, 's&d supply')).toBe('v-1');
    expect(matchVendorByName(vendors, '  ULINE')).toBe('v-2');
  });

  it('matches through merchant normalization (processor suffixes, punctuation, aliases)', () => {
    expect(matchVendorByName(vendors, 'Home Depot #123')).toBe('v-3');
    expect(matchVendorByName([{ id: 'v-w', name: 'Walmart' }], 'WAL-MART #1234')).toBe('v-w');
    expect(matchVendorByName([{ id: 'v-a', name: 'Amazon' }], 'AMZN Mktp US*1A2B3C')).toBe('v-a');
  });

  it('returns null when nothing matches after normalization', () => {
    expect(matchVendorByName(vendors, 'S&D')).toBeNull();
    expect(matchVendorByName(vendors, 'Costco')).toBeNull();
  });

  it('returns null for an empty merchant', () => {
    expect(matchVendorByName(vendors, '  ')).toBeNull();
  });
});
