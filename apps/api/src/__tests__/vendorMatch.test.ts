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

  it('returns null when nothing matches exactly (no fuzzy matching)', () => {
    expect(matchVendorByName(vendors, 'S&D')).toBeNull();
    expect(matchVendorByName(vendors, 'Home Depot #123')).toBeNull();
  });

  it('returns null for an empty merchant', () => {
    expect(matchVendorByName(vendors, '  ')).toBeNull();
  });
});
