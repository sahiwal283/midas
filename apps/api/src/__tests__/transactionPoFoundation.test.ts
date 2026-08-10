import { describe, expect, it } from 'vitest';
import {
  deriveIntegrationStatus,
  expenseStatusToTransactionStatus,
  toWireExpenseStatus,
  transactionStatusToExpenseStatus,
} from '../lib/transactionStatus';
import { buildPoIdempotencyKey } from '../lib/zohoIds';
import { canSessionDeleteExpense } from '../lib/expenseDelete';

describe('transactionStatus mapping', () => {
  it('maps pending → submitted and zoho_sync_failed → approved', () => {
    expect(expenseStatusToTransactionStatus('pending')).toBe('submitted');
    expect(expenseStatusToTransactionStatus('zoho_sync_failed')).toBe('approved');
  });

  it('wire status exposes zoho_sync_failed when integration failed', () => {
    expect(toWireExpenseStatus('approved', 'failed')).toBe('zoho_sync_failed');
    expect(transactionStatusToExpenseStatus('approved', 'failed')).toBe('zoho_sync_failed');
  });

  it('derives integration from zoho linkage', () => {
    expect(deriveIntegrationStatus({ zohoRecordId: 'z1', zohoEntity: 'X' })).toBe('synced');
    expect(deriveIntegrationStatus({ zohoRecordId: null, zohoEntity: 'X', legacyStatus: 'zoho_sync_failed' })).toBe('failed');
    expect(deriveIntegrationStatus({ zohoRecordId: null, zohoEntity: 'X' })).toBe('pending');
    expect(deriveIntegrationStatus({ zohoRecordId: null, zohoEntity: null, zohoEnabled: false })).toBe('not_required');
  });
});

describe('PO idempotency', () => {
  it('is stable per transaction id', () => {
    const id = '11111111-1111-1111-1111-111111111111';
    expect(buildPoIdempotencyKey(id)).toBe(`midas-po-${id}`);
    expect(buildPoIdempotencyKey(id)).toBe(buildPoIdempotencyKey(id));
  });
});

describe('canSessionDeleteExpense soft-cancel', () => {
  const base = {
    userId: 'u1',
    status: 'pending',
    reviewedAt: null as Date | null,
    zohoExpenseId: null as string | null,
  };

  it('hard-deletes owner drafts', () => {
    const d = canSessionDeleteExpense({
      role: 'user',
      actorUserId: 'u1',
      expense: { ...base, status: 'draft' },
    });
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.mode).toBe('hard_delete');
  });

  it('soft-cancels owner unreviewed pending', () => {
    const d = canSessionDeleteExpense({
      role: 'user',
      actorUserId: 'u1',
      expense: base,
    });
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.mode).toBe('soft_cancel');
  });

  it('blocks synced without admin force', () => {
    const d = canSessionDeleteExpense({
      role: 'accountant',
      actorUserId: 'a1',
      expense: { ...base, zohoExpenseId: 'z-1', integrationStatus: 'synced' },
      force: true,
    });
    expect(d.ok).toBe(false);
  });

  it('admin force soft-cancels synced', () => {
    const d = canSessionDeleteExpense({
      role: 'admin',
      actorUserId: 'admin',
      expense: { ...base, zohoExpenseId: 'z-1', integrationStatus: 'synced' },
      force: true,
    });
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.mode).toBe('soft_cancel');
  });
});
