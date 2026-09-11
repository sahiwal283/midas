import { describe, it, expect } from 'vitest';

import { catalogBrandFor } from '../lib/zohoBrand';

describe('catalogBrandFor', () => {
  it('resolves the brand of the company the picker is scoped to', () => {
    expect(catalogBrandFor('Boomin Brands', 'haute_brands')).toBe('boomin_brands');
    expect(catalogBrandFor('Nirvana Kulture', 'haute_brands')).toBe('nirvana_kulture');
  });

  it('accepts the brand slug itself as the entity', () => {
    expect(catalogBrandFor('summitt_labs', 'haute_brands')).toBe('summitt_labs');
  });

  it('ignores case and surrounding whitespace', () => {
    expect(catalogBrandFor('  boomin brands ', 'haute_brands')).toBe('boomin_brands');
  });

  // Without a company the caller has nothing to scope to, so the default brand
  // is the only answer available — the UI gates the pickers precisely so this
  // path stops being how a real vendor list gets chosen.
  it('falls back to the default brand when no company is given', () => {
    expect(catalogBrandFor(undefined, 'haute_brands')).toBe('haute_brands');
    expect(catalogBrandFor('', 'haute_brands')).toBe('haute_brands');
    expect(catalogBrandFor('   ', 'haute_brands')).toBe('haute_brands');
  });

  // A company Midas knows but the Zoho brand map does not: the safe answer is
  // still the default brand, never a guess at a neighbouring brand.
  it('falls back to the default brand for an unmapped company', () => {
    expect(catalogBrandFor('Some New Co', 'haute_brands')).toBe('haute_brands');
  });
});
