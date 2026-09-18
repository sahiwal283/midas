/**
 * OCR correction reporting — no database, no network.
 *
 * Covers:
 *  - the POST contract to the OCR service (URL, headers, one body per field)
 *  - retry-once-then-count-a-failure, without throwing into the caller
 *  - the first-receipt selection rule: only the receipt that prefilled the
 *    form is ever diffed, so a later scan can never invent corrections
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env', () => ({
  env: { OCR_MODE: 'service', OCR_BASE_URL: 'http://ocr.test', OCR_SERVICE_INTERNAL_TOKEN: 'tok', OCR_CLIENT_APP: 'midas' },
}));

const dbMock = vi.hoisted(() => {
  const findFirst = vi.fn();
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { findFirst, where, set, update };
});

vi.mock('../db/index', () => ({
  db: { query: { expenses: { findFirst: dbMock.findFirst } }, update: dbMock.update },
}));

vi.mock('../lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { reportOcrCorrectionsForExpense, sendCorrections } from '../lib/reportOcrCorrections';

describe('sendCorrections', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('posts one correction per field with service headers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const res = await sendCorrections('req-1', [
      { field: 'amount', original_value: '9.72', corrected_value: '97.20' },
      { field: 'merchant', original_value: null, corrected_value: 'Uline' },
    ], { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(res).toEqual({ sent: 2, failed: 0 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://ocr.test/ocr/corrections');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'X-Internal-Token': 'tok', 'X-Client-App': 'midas', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ request_id: 'req-1', field: 'amount', original_value: '9.72', corrected_value: '97.20' });
  });

  it('retries once, then counts a failure without throwing', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ ok: false, status: 503 });
    const res = await sendCorrections('req-1', [{ field: 'date', original_value: 'a', corrected_value: 'b' }], { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ sent: 0, failed: 1 });
  });
});

describe('reportOcrCorrectionsForExpense', () => {
  const receipt = (over: Record<string, unknown> = {}) => ({
    id: 'rec-1',
    uploadedAt: new Date('2026-09-16T10:00:00Z'),
    ocrStatus: 'done',
    ocrRequestId: 'req-1',
    ocrCorrectionsReportedAt: null,
    ocrData: { fields: { amount: { value: '9.72', source: 'llm' }, merchant: { value: 'Uline', source: 'llm' } } },
    ...over,
  });
  const expense = (receipts: unknown[]) => ({
    id: 'exp-1',
    merchant: 'Uline',
    amount: '97.20',
    date: '2026-09-16',
    category: { name: 'Shipping Supplies' },
    paymentMethod: { lastFour: '4242' },
    receipts,
  });

  let fetchImpl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchImpl);
  });

  it('reports corrections against the first receipt and marks it reported', async () => {
    dbMock.findFirst.mockResolvedValueOnce(expense([receipt()]));

    const res = await reportOcrCorrectionsForExpense('exp-1');

    expect(res.status).toBe('reported');
    expect(res.corrections).toEqual([{ field: 'amount', original_value: '9.72', corrected_value: '97.20' }]);
    expect(res).toMatchObject({ sent: 1, failed: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(dbMock.set).toHaveBeenCalledWith({ ocrCorrectionsReportedAt: expect.any(Date) });
  });

  // The query returns the first receipt only; both are passed here to prove the
  // reporter never falls through to a later scan the user never saw.
  it('skips when the first receipt failed OCR, even if a later one succeeded', async () => {
    dbMock.findFirst.mockResolvedValueOnce(expense([
      receipt({ id: 'rec-1', ocrStatus: 'failed', ocrRequestId: null, ocrData: null }),
      receipt({ id: 'rec-2', uploadedAt: new Date('2026-09-16T11:00:00Z'), ocrRequestId: 'req-2' }),
    ]));

    const res = await reportOcrCorrectionsForExpense('exp-1');

    expect(res).toEqual({ status: 'skipped', reason: 'first_receipt_not_scanned', corrections: [], sent: 0, failed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('skips an expense with no receipts', async () => {
    dbMock.findFirst.mockResolvedValueOnce(expense([]));

    const res = await reportOcrCorrectionsForExpense('exp-1');

    expect(res).toEqual({ status: 'skipped', reason: 'no_receipt', corrections: [], sent: 0, failed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips a receipt already reported, so a resubmit never double-counts', async () => {
    dbMock.findFirst.mockResolvedValueOnce(expense([receipt({ ocrCorrectionsReportedAt: new Date('2026-09-17T00:00:00Z') })]));

    const res = await reportOcrCorrectionsForExpense('exp-1');

    expect(res).toEqual({ status: 'skipped', reason: 'already_reported', corrections: [], sent: 0, failed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
