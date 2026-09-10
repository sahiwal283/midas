import { describe, expect, it } from 'vitest';
import { MAX_WAIVER_REASON } from '@midas/shared';
import { receiptPushBlocker, normalizeWaiverReason } from '../lib/receiptPushBlocker';

const WITH_RECEIPT = { hasReceipt: true, storedWaiverReason: null };
const BARE = { hasReceipt: false, storedWaiverReason: null };

describe('receiptPushBlocker', () => {
  it('passes when a receipt is attached', () => {
    expect(receiptPushBlocker(WITH_RECEIPT)).toBeNull();
  });

  it('blocks a receipt-less expense with no waiver at all', () => {
    const blocker = receiptPushBlocker(BARE);
    expect(blocker?.code).toBe('MISSING_RECEIPT');
    expect(blocker?.status).toBe(409);
  });

  it('tells the accountant both ways out', () => {
    expect(receiptPushBlocker(BARE)!.message).toMatch(/reason/i);
    expect(receiptPushBlocker(BARE)!.message).toMatch(/attach/i);
  });

  it('passes on a reason supplied with this push', () => {
    expect(receiptPushBlocker({ ...BARE, suppliedReason: 'submitter lost it' })).toBeNull();
  });

  it('passes on a reason already stored, so a retry needs no retyping', () => {
    expect(receiptPushBlocker({ hasReceipt: false, storedWaiverReason: 'lost, verified on statement' }))
      .toBeNull();
  });

  it('rejects a whitespace-only reason rather than storing an empty justification', () => {
    const blocker = receiptPushBlocker({ ...BARE, suppliedReason: '   \n  ' });
    expect(blocker?.code).toBe('INVALID_WAIVER_REASON');
    expect(blocker?.status).toBe(400);
  });

  it('rejects a reason longer than the shared maximum', () => {
    const blocker = receiptPushBlocker({ ...BARE, suppliedReason: 'x'.repeat(MAX_WAIVER_REASON + 1) });
    expect(blocker?.code).toBe('INVALID_WAIVER_REASON');
  });

  it('accepts a reason of exactly the maximum length', () => {
    expect(receiptPushBlocker({ ...BARE, suppliedReason: 'x'.repeat(MAX_WAIVER_REASON) })).toBeNull();
  });

  it('measures the maximum after trimming, not before', () => {
    const padded = `  ${'x'.repeat(MAX_WAIVER_REASON)}  `;
    expect(receiptPushBlocker({ ...BARE, suppliedReason: padded })).toBeNull();
  });

  it('lets an attached receipt win even when a bad reason is also supplied', () => {
    expect(receiptPushBlocker({ ...WITH_RECEIPT, suppliedReason: '  ' })).toBeNull();
  });
});

describe('normalizeWaiverReason', () => {
  it('returns null for undefined, empty and whitespace', () => {
    expect(normalizeWaiverReason(undefined)).toBeNull();
    expect(normalizeWaiverReason('')).toBeNull();
    expect(normalizeWaiverReason('   ')).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeWaiverReason('  lost the receipt  ')).toBe('lost the receipt');
  });
});
