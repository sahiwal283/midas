import { describe, it, expect } from 'vitest';
import { listZohoEntities, resolveBrandFromEntity } from '../lib/zohoBrand';

describe('resolveBrandFromEntity', () => {
  it('maps known entity labels', () => {
    expect(resolveBrandFromEntity('Haute Brands')).toBe('haute_brands');
    expect(resolveBrandFromEntity('Boomin Brands')).toBe('boomin_brands');
    expect(resolveBrandFromEntity('Nirvana Kulture')).toBe('nirvana_kulture');
    expect(resolveBrandFromEntity('Summitt Labs')).toBe('summitt_labs');
  });

  it('accepts brand slugs directly', () => {
    expect(resolveBrandFromEntity('haute_brands')).toBe('haute_brands');
  });

  it('returns null for unknown / empty', () => {
    expect(resolveBrandFromEntity(null)).toBeNull();
    expect(resolveBrandFromEntity('')).toBeNull();
    expect(resolveBrandFromEntity('Unknown Co')).toBeNull();
  });
});

describe('listZohoEntities', () => {
  it('includes Haute Brands', () => {
    expect(listZohoEntities().some((e) => e.entity === 'Haute Brands')).toBe(true);
  });
});
