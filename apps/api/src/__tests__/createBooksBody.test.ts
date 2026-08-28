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
  // The description now carries a provenance block under the human sentence,
  // so these assert the headline — the first line — rather than the whole field.
  const headline = (d: unknown) => String(d).split('\n')[0];

  it('prefixes the merchant into the description so the Zoho Books record is searchable', () => {
    const body = toCreateBooksBody({ ...base, description: 'Pallet wrap & tape' });
    expect(headline(body.description)).toBe('S&D Supply — Pallet wrap & tape');
  });

  it('uses the merchant alone when there are no notes', () => {
    const body = toCreateBooksBody({ ...base, description: null });
    expect(headline(body.description)).toBe('S&D Supply');
  });

  it('does not double-prefix when the notes already lead with the merchant', () => {
    const body = toCreateBooksBody({ ...base, description: 'S&D Supply invoice 42' });
    expect(headline(body.description)).toBe('S&D Supply invoice 42');
  });

  it('carries provenance Zoho has no other record of', () => {
    const body = toCreateBooksBody({
      ...base,
      description: 'Pallet wrap & tape',
      source: { app: 'browser_extension', type: null, id: null, url: 'https://shop.example/r/9', label: 'Champs Summer LV 2026' },
      provenance: {
        submittedBy: 'Shruti Patel', submittedOn: '2026-08-25',
        pushedBy: 'Sahil Khatri', pushedOn: '2026-08-27',
        midasUrl: 'https://midas.example/expenses/e-1',
      },
    });
    expect(body.description).toBe(
      'S&D Supply — Pallet wrap & tape\n'
      + '\n'
      + 'Event: Champs Summer LV 2026\n'
      + 'Submitted by: Shruti Patel on 2026-08-25\n'
      + 'Pushed by: Sahil Khatri on 2026-08-27\n'
      + 'Origin: Midas Extension\n'
      + 'Midas: https://midas.example/expenses/e-1\n'
      + 'Source: https://shop.example/r/9',
    );
  });

  it('reads Midas as the origin when nothing external submitted it', () => {
    const body = toCreateBooksBody({ ...base, description: null, source: { app: 'midas', type: null, id: null, url: null, label: null } });
    expect(body.description).toContain('Origin: Midas');
  });

  it('still sends the raw merchant field for the integration service', () => {
    const body = toCreateBooksBody({ ...base, description: null });
    expect(body.merchant).toBe('S&D Supply');
  });

  it('forwards reference_number when set and omits it when empty', () => {
    expect(toCreateBooksBody({ ...base, reference_number: '02456' }).reference_number).toBe('02456');
    expect(toCreateBooksBody({ ...base, reference_number: null }).reference_number).toBeUndefined();
    expect(toCreateBooksBody(base).reference_number).toBeUndefined();
  });
});
