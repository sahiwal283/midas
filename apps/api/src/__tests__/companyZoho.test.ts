import { describe, it, expect, vi } from 'vitest';

// Mock env so importing this module's `db` import doesn't require real
// DATABASE_URL/JWT_SECRET — same pattern as zohoReadiness.test.ts / zohoService.test.ts.
vi.mock('../config/env', () => ({
  env: {
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  },
}));

import { buildZohoEnabledMap } from '../lib/companyZoho';

describe('buildZohoEnabledMap', () => {
  it('maps company name to whether it can post to Zoho', () => {
    const m = buildZohoEnabledMap([
      { name: 'Haute Brands', zohoEnabled: true, isActive: true },
      { name: 'Summitt Labs', zohoEnabled: false, isActive: true },
    ]);
    expect(m.get('Haute Brands')).toBe(true);
    expect(m.get('Summitt Labs')).toBe(false);
  });

  it('treats an inactive company as not Zoho-capable', () => {
    const m = buildZohoEnabledMap([{ name: 'Old Co', zohoEnabled: true, isActive: false }]);
    expect(m.get('Old Co')).toBe(false);
  });

  it('returns an empty map for no companies', () => {
    expect(buildZohoEnabledMap([]).size).toBe(0);
  });
});
