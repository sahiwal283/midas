import { describe, expect, it, vi } from 'vitest';

// Mock env so tests don't require real env vars (same pattern as zohoReadiness.test)
vi.mock('../config/env', () => ({
  env: {
    ZOHO_MODE: 'mock' as const,
    ZOHO_DRY_RUN: false,
    ZOHO_DEFAULT_BRAND: 'haute_brands',
    LOG_LEVEL: 'silent',
  },
}));

import { toCreateBooksBody } from '../lib/zoho';

const base = {
  expenseId: 'e-1',
  merchant: 'S&D Supply',
  amount: '130.01',
  currency: 'USD',
  date: '2026-08-13',
  zohoEntity: 'Haute Brands',
  brand: 'haute_brands',
} as any;

describe('toCreateBooksBody', () => {
  it('prefixes the merchant into the description so the Zoho Books record is searchable', () => {
    const body = toCreateBooksBody({ ...base, description: 'Pallet wrap & tape' });
    expect(body.description).toBe('S&D Supply — Pallet wrap & tape');
  });

  it('uses the merchant alone when there are no notes', () => {
    const body = toCreateBooksBody({ ...base, description: null });
    expect(body.description).toBe('S&D Supply');
  });

  it('does not double-prefix when the notes already lead with the merchant', () => {
    const body = toCreateBooksBody({ ...base, description: 'S&D Supply invoice 42' });
    expect(body.description).toBe('S&D Supply invoice 42');
  });

  it('still sends the raw merchant field for the integration service', () => {
    const body = toCreateBooksBody({ ...base, description: null });
    expect(body.merchant).toBe('S&D Supply');
  });
});
