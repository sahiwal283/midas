import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env', () => ({
  env: {
    ZOHO_MODE: 'mock' as const,
    ZOHO_DRY_RUN: false,
    ZOHO_DEFAULT_BRAND: 'haute_brands',
    ZOHO_SERVICE_BASE_URL: undefined as string | undefined,
    ZOHO_SERVICE_TOKEN: undefined as string | undefined,
  },
}));

import type { ZohoPoServicePayload } from '../lib/zohoPoPayload';
import { toZohoBooksPoCreateBody } from '../lib/zohoPoPayload';

const base: ZohoPoServicePayload = {
  idempotencyKey: 'midas-po-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  transactionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  poNumber: null,
  vendor: { name: 'ABC Foods', zohoVendorId: '5254962000007610090' },
  date: '2026-08-10',
  currency: 'USD',
  taxTotal: '0',
  total: '53',
  brand: 'haute_brands',
  zohoEntity: 'Haute Brands',
  lineItems: [
    {
      lineNumber: 1,
      description: 'Mini Marshmallows',
      quantity: '10',
      unit: 'bag',
      unitPrice: '5.30',
      tax: '0',
      total: '53.00',
      zohoItemId: '5254962000006728016',
    },
  ],
  receipt: null,
  source: { app: 'midas', type: 'purchase_order', id: null, url: null, label: null },
};

describe('toZohoBooksPoCreateBody', () => {
  it('emits Books wire fields only (no camelCase lineItems/source)', () => {
    const body = toZohoBooksPoCreateBody(base);
    expect(body.vendor_id).toBe('5254962000007610090');
    expect(body.line_items).toEqual([
      { item_id: '5254962000006728016', quantity: 10, rate: 5.3, name: 'Mini Marshmallows' },
    ]);
    expect(body.idempotencyKey).toBe('midas-po-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(body.reference_number).toContain('midas-po-');
    expect(JSON.stringify(body)).not.toContain('lineItems');
    expect(JSON.stringify(body)).not.toContain('"source"');
  });

  it('rejects missing vendor / item ids', () => {
    expect(() => toZohoBooksPoCreateBody({
      ...base,
      vendor: { name: 'X', zohoVendorId: null },
    })).toThrow(/zohoVendorId/);
    expect(() => toZohoBooksPoCreateBody({
      ...base,
      lineItems: [{ ...base.lineItems[0], zohoItemId: null }],
    })).toThrow(/Zoho item/);
  });
});
