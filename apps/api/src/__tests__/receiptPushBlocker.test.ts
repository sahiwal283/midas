import { describe, expect, it } from 'vitest';
import { MAX_WAIVER_REASON } from '@midas/shared';
import { receiptPushBlocker, normalizeWaiverReason, shouldRecordWaiver } from '../lib/receiptPushBlocker';

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

  it('blocks on a stored reason that is only whitespace — a corrupted row is not a waiver', () => {
    const blocker = receiptPushBlocker({ hasReceipt: false, storedWaiverReason: '   ' });
    expect(blocker?.code).toBe('MISSING_RECEIPT');
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

describe('shouldRecordWaiver', () => {
  it('records a waiver for a receipt-less expense with a fresh reason', () => {
    expect(shouldRecordWaiver({ ...BARE, suppliedReason: 'submitter lost it' })).toBe(true);
  });

  it('records NOTHING when the expense has a receipt, even if a reason is supplied', () => {
    // The regression this guards: receiptPushBlocker returns null on
    // hasReceipt without ever looking at suppliedReason, so deciding the write
    // from that null stamped `receipt_waiver_reason` and an immutable
    // `expense.receipt_waived` audit entry onto an expense whose receipt was
    // attached to the same Zoho record moments later. Reachable by any
    // accountant posting the field with curl.
    expect(shouldRecordWaiver({ ...WITH_RECEIPT, suppliedReason: 'submitter lost it' })).toBe(false);
  });

  it('records nothing when a waiver is already stored — the first reason stands', () => {
    expect(shouldRecordWaiver({
      hasReceipt: false,
      storedWaiverReason: 'lost, verified on statement',
      suppliedReason: 'a second, different reason',
    })).toBe(false);
  });

  it('records nothing when no reason was supplied', () => {
    expect(shouldRecordWaiver(BARE)).toBe(false);
  });

  it('records nothing for a whitespace-only reason', () => {
    expect(shouldRecordWaiver({ ...BARE, suppliedReason: '  \n ' })).toBe(false);
  });

  it('treats a whitespace-only STORED reason as absent, so a real reason replaces it', () => {
    expect(shouldRecordWaiver({
      hasReceipt: false,
      storedWaiverReason: '   ',
      suppliedReason: 'submitter lost it',
    })).toBe(true);
  });
});
