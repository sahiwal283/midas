import { describe, it, expect, vi } from 'vitest';

// Mock env so tests don't require real DATABASE_URL/JWT_SECRET (same pattern as zohoService.test.ts).
vi.mock('../config/env', () => ({
  env: {
    ZOHO_MODE: 'mock' as const,
    ZOHO_DRY_RUN: false,
    ZOHO_DEFAULT_BRAND: 'haute_brands',
    ZOHO_SERVICE_BASE_URL: undefined as string | undefined,
    ZOHO_SERVICE_TOKEN: undefined as string | undefined,
  },
}));

import { buildZohoServicePayload, type PayloadExpense } from '../lib/zohoPayload';

const base: PayloadExpense = {
  id: 'e1',
  merchant: 'Southwest Airlines',
  amount: '305.80',
  currency: 'USD',
  date: '2026-07-31',
  description: null,
  categoryId: 'cat1',
  paymentMethodId: 'pm1',
  zohoEntity: 'Nirvana Kulture',
  reimbursementStatus: 'not_requested',
  userId: 'u1',
  category: { name: 'Travel - Flight', zohoAccountId: 'legacy-fallback-id' },
  paymentMethod: { label: 'Nirvana PNC', zohoAccountName: '1234567890123' },
};

describe('per-entity Zoho account resolution', () => {
  it('uses categoryEntityAccountId when no per-expense COA pick exists', () => {
    const p = buildZohoServicePayload({ ...base, categoryEntityAccountId: 'entity-id-1' });
    expect(p.account_id).toBe('entity-id-1');
  });

  it('per-expense COA pick still wins over the entity mapping', () => {
    const p = buildZohoServicePayload({
      ...base,
      zohoExpenseAccountId: 'live-pick-id',
      categoryEntityAccountId: 'entity-id-1',
    });
    expect(p.account_id).toBe('live-pick-id');
  });

  it('falls back to legacy category.zohoAccountId when no entity mapping', () => {
    const p = buildZohoServicePayload({ ...base, categoryEntityAccountId: null });
    expect(p.account_id).toBe('legacy-fallback-id');
  });
});
