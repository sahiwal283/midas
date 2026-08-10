import { describe, expect, it } from 'vitest';
import {
  isPoReadyForZohoPush,
  partitionPoBulkApprove,
  partitionPoBulkPush,
  poApproveFlags,
  type PoBulkRow,
} from '../lib/bulkPoReview';

function po(partial: Partial<PoBulkRow> & { id?: string } = {}): PoBulkRow {
  return {
    id: partial.id ?? 'x',
    status: 'submitted',
    type: 'purchase_order',
    total: '10',
    integrationStatus: 'not_required',
    zohoEntity: 'Haute Brands',
    purchaseOrder: { zohoVendorId: 'v1' },
    lineItems: [{ zohoItemId: 'i1' }],
    ...partial,
  };
}

describe('poApproveFlags', () => {
  it('flags awaiting_info, empty lines, missing vendor/item', () => {
    expect(poApproveFlags(po({ status: 'awaiting_info' }))).toContain('awaiting_info');
    expect(poApproveFlags(po({ lineItems: [], lineItemCount: 0 }))).toContain('no_line_items');
    expect(poApproveFlags(po({ purchaseOrder: { zohoVendorId: null } }))).toContain('missing_zoho_vendor');
    expect(poApproveFlags(po({ lineItems: [{ zohoItemId: null }] }))).toContain('missing_zoho_item');
  });
});

describe('partitionPoBulkApprove', () => {
  it('approves submitted/in_review and skips others', () => {
    const rows = [
      po({ id: 'a', status: 'submitted' }),
      po({ id: 'b', status: 'in_review' }),
      po({ id: 'c', status: 'awaiting_info' }),
      po({ id: 'd', status: 'approved' }),
    ];
    const r = partitionPoBulkApprove(rows, ['a', 'b', 'c', 'd', 'missing']);
    expect(r.approvable).toEqual(['a', 'b']);
    expect(r.skipped.map((s) => s.id).sort()).toEqual(['c', 'd', 'missing']);
  });
});

describe('isPoReadyForZohoPush / partitionPoBulkPush', () => {
  it('requires approved (or failed integration), vendor, items, no zoho id', () => {
    expect(isPoReadyForZohoPush(po({
      status: 'approved',
      integrationStatus: 'pending',
      zohoRecordId: null,
      zohoEntity: 'Haute Brands',
    }))).toBe(true);

    expect(isPoReadyForZohoPush(po({
      status: 'approved',
      zohoEntity: 'Haute Brands',
      zohoRecordId: 'ZOHO-1',
    }))).toBe(false);

    const rows = [
      po({ id: 'ok', status: 'approved', integrationStatus: 'pending', zohoEntity: 'Haute Brands' }),
      po({ id: 'no', status: 'submitted', zohoEntity: 'Haute Brands' }),
    ];
    const r = partitionPoBulkPush(rows, ['ok', 'no']);
    expect(r.ready).toEqual(['ok']);
    expect(r.skipped).toHaveLength(1);
  });
});
