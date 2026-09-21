/**
 * OCR correction reporting — no database, no network.
 *
 * Covers:
 *  - the POST contract to the OCR service (URL, headers, one body per field)
 *  - retry on transport failures and 5xx only, never on a 4xx
 *  - the first-receipt selection rule: only the receipt that prefilled the
 *    form is ever diffed, so a later scan can never invent corrections
 *  - the claim/release of ocr_corrections_reported_at: claimed before any
 *    send so a concurrent resubmit cannot report the same receipt twice,
 *    released again whenever a field could still land so the backfill can
 *    redeliver it
 *  - the invariant that a released claim never sends the reviewed ack, and
 *    that a receipt which could not be released is never acked either
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';

// OCR_TIMEOUT_MS is the real 120s upload default, so the timeout test can show
// the corrections POST capping itself well below it.
vi.mock('../config/env', () => ({
  env: { OCR_MODE: 'service', OCR_BASE_URL: 'http://ocr.test', OCR_SERVICE_INTERNAL_TOKEN: 'tok', OCR_CLIENT_APP: 'midas', OCR_TIMEOUT_MS: 120_000 },
}));

const dbMock = vi.hoisted(() => {
  const findFirst = vi.fn();
  const returning = vi.fn();
  const where = vi.fn(() => Object.assign(Promise.resolve(undefined), { returning }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { findFirst, returning, where, set, update };
});

vi.mock('../db/index', () => ({
  db: { query: { expenses: { findFirst: dbMock.findFirst } }, update: dbMock.update },
}));

vi.mock('../lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { env } from '../config/env';
import { logger } from '../lib/logger';
import * as schema from '../db/schema';
import { reportOcrCorrectionsForExpense, sendCorrections, sendReviewedAck } from '../lib/reportOcrCorrections';

const okResponse = { ok: true, status: 202 };

/** The reviewed-ack POSTs among a fetch mock's calls (the rest are corrections). */
const ackCalls = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls.filter(([url]) => String(url) === 'http://ocr.test/ocr/corrections/reviewed');

describe('sendCorrections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.OCR_MODE = 'service';
  });

  it('posts one correction per field with service headers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse);
    const res = await sendCorrections('req-1', [
      { field: 'amount', original_value: '9.72', corrected_value: '97.20' },
      { field: 'merchant', original_value: null, corrected_value: 'Uline' },
    ], { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(res).toEqual({ sent: 2, failed: 0, retryableFields: [], rejectedFields: [] });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://ocr.test/ocr/corrections');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'X-Internal-Token': 'tok', 'X-Client-App': 'midas', 'Content-Type': 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toEqual({ request_id: 'req-1', field: 'amount', original_value: '9.72', corrected_value: '97.20' });
  });

  it('retries once, then counts a failure without throwing', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ ok: false, status: 503, body: { cancel: vi.fn().mockResolvedValue(undefined) } });
    const res = await sendCorrections('req-1', [{ field: 'date', original_value: 'a', corrected_value: 'b' }], { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ sent: 0, failed: 1, retryableFields: ['date'], rejectedFields: [] });
  });

  it.each([400, 422])('does not retry a %i, a malformed-body or unknown-field response the service will reject again', async (status) => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status, body: { cancel } });
    const res = await sendCorrections('req-1', [{ field: 'date', original_value: 'a', corrected_value: 'b' }], { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalled();
    expect(res).toEqual({ sent: 0, failed: 1, retryableFields: [], rejectedFields: [{ field: 'date', status }] });
  });

  // 401/403/404/408/425 are configuration or transport states that get fixed
  // (a rotated token, a flipped auth flag, a route-prefix change) — treating
  // them as permanent would destroy the correction forever on the first hit.
  it.each([401, 403, 404, 408, 425])('retries a %i auth/routing failure like a 5xx', async (status) => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status, body: { cancel } });
    const res = await sendCorrections('req-1', [{ field: 'date', original_value: 'a', corrected_value: 'b' }], { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ sent: 0, failed: 1, retryableFields: ['date'], rejectedFields: [] });
  });

  it('aborts a hung request at the 10s cap, not the 120s upload timeout', async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        const signal = init.signal!;
        signals.push(signal);
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }));
      const res = sendCorrections('req-1', [{ field: 'date', original_value: 'a', corrected_value: 'b' }], { fetchImpl: fetchImpl as unknown as typeof fetch });

      await vi.advanceTimersByTimeAsync(9_999);
      expect(signals[0].aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signals[0].aborted).toBe(true);

      await vi.advanceTimersByTimeAsync(10_000); // the one retry hangs too
      expect(await res).toEqual({ sent: 0, failed: 1, retryableFields: ['date'], rejectedFields: [] });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('sendReviewedAck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.OCR_MODE = 'service';
  });

  it('posts the ack with service headers, no retry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse);
    await expect(sendReviewedAck('req-1', { fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://ocr.test/ocr/corrections/reviewed');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'X-Internal-Token': 'tok', 'X-Client-App': 'midas', 'Content-Type': 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toEqual({ request_id: 'req-1' });
  });

  it('never throws when the request errors outright, and reports the ack as not landed', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    await expect(sendReviewedAck('req-1', { fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([404, 503])('does not retry a %i and never throws', async (status) => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status, body: { cancel } });
    await expect(sendReviewedAck('req-1', { fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalled();
  });

  it('aborts a hung request at the 10s cap and resolves cleanly, with no retry', async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        const signal = init.signal!;
        signals.push(signal);
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }));
      const res = sendReviewedAck('req-1', { fetchImpl: fetchImpl as unknown as typeof fetch });

      await vi.advanceTimersByTimeAsync(9_999);
      expect(signals[0].aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signals[0].aborted).toBe(true);

      // Swallowed, not retried: the abort's rejection resolves the ack to
      // false rather than throwing or hanging on a second attempt.
      await expect(res).resolves.toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reportOcrCorrectionsForExpense', () => {
  const fields = { amount: { value: '9.72', source: 'llm' }, merchant: { value: 'Uline', source: 'llm' } };
  const receipt = (over: Record<string, unknown> = {}) => ({
    id: 'rec-1',
    uploadedAt: new Date('2026-09-16T10:00:00Z'),
    ocrStatus: 'done',
    ocrRequestId: 'req-1',
    ocrCorrectionsReportedAt: null,
    ocrData: { fields },
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

  const bothFieldsWrong = { fields: { amount: { value: '9.72', source: 'llm' }, merchant: { value: 'Ulinee Corp', source: 'llm' } } };

  beforeEach(() => {
    vi.clearAllMocks();
    env.OCR_MODE = 'service';
    dbMock.returning.mockResolvedValue([{ id: 'rec-1' }]);
    fetchImpl = vi.fn().mockResolvedValue(okResponse);
    vi.stubGlobal('fetch', fetchImpl);
  });

  it('reports corrections against the first receipt and stamps it', async () => {
    dbMock.findFirst.mockResolvedValueOnce(expense([receipt()]));

    const res = await reportOcrCorrectionsForExpense('exp-1');

    expect(res.status).toBe('reported');
    expect(res.corrections).toEqual([{ field: 'amount', original_value: '9.72', corrected_value: '97.20' }]);
    expect(res).toMatchObject({ sent: 1, failed: 0 });
    // One POST for the correction, one for the reviewed ack — see the
    // dedicated ack tests below for the detailed contract on each.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(dbMock.set).toHaveBeenCalledExactlyOnceWith({ ocrCorrectionsReportedAt: expect.any(Date) });
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

  it('sends nothing when a concurrent writer claimed the receipt first', async () => {
    dbMock.findFirst.mockResolvedValueOnce(expense([receipt()]));
    dbMock.returning.mockResolvedValueOnce([]);

    const res = await reportOcrCorrectionsForExpense('exp-1');

    expect(res).toEqual({ status: 'skipped', reason: 'already_reported', corrections: [], sent: 0, failed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stamps a receipt whose fields the user did not change', async () => {
    dbMock.findFirst.mockResolvedValueOnce(expense([receipt({ ocrData: { fields: { amount: { value: '97.20', source: 'llm' } } } })]));

    const res = await reportOcrCorrectionsForExpense('exp-1');

    expect(res).toEqual({ status: 'reported', corrections: [], sent: 0, failed: 0 });
    // No correction to send, but the ack still fires — see the dedicated
    // "no corrections" ack test below for the detailed contract.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(dbMock.set).toHaveBeenCalledExactlyOnceWith({ ocrCorrectionsReportedAt: expect.any(Date) });
  });

  it('releases the claim when every send failed, so the backfill can retry', async () => {
    dbMock.findFirst.mockResolvedValueOnce(expense([receipt()]));
    fetchImpl.mockRejectedValue(new Error('ECONNRESET'));

    const res = await reportOcrCorrectionsForExpense('exp-1');

    expect(res).toMatchObject({ status: 'send_failed', sent: 0, failed: 1 });
    expect(dbMock.set).toHaveBeenLastCalledWith({ ocrCorrectionsReportedAt: null });
    // The claim is released, so this receipt has not been reported yet: an ack
    // here would tell the OCR service the job was reviewed with nothing to
    // correct — i.e. score it right first time. The retry sends the ack.
    expect(ackCalls(fetchImpl)).toHaveLength(0);
  });

  it.each([400, 422])('keeps the stamp when the service refuses with a permanent %i', async (status) => {
    dbMock.findFirst.mockResolvedValueOnce(expense([receipt()]));
    fetchImpl.mockResolvedValue({ ok: false, status });

    const res = await reportOcrCorrectionsForExpense('exp-1');

    // A 400/422 never succeeds on a retry, so releasing the claim would only
    // make the backfill re-POST this receipt on every run, forever.
    expect(res).toMatchObject({ status: 'rejected', sent: 0, failed: 1 });
    expect(dbMock.set).toHaveBeenCalledExactlyOnceWith({ ocrCorrectionsReportedAt: expect.any(Date) });
    // The claim is kept, so reporting this receipt is finished: the ack fires.
    expect(ackCalls(fetchImpl)).toHaveLength(1);
  });

  it.each([401, 403, 404, 408, 425])('releases the claim when the service answers with a fixable %i', async (status) => {
    dbMock.findFirst.mockResolvedValueOnce(expense([receipt()]));
    fetchImpl.mockResolvedValue({ ok: false, status });

    const res = await reportOcrCorrectionsForExpense('exp-1');

    // A rotated token, a flipped auth flag or a route-prefix change gets
    // fixed — the claim must release so the backfill retries this receipt
    // instead of losing the correction forever.
    expect(res).toMatchObject({ status: 'send_failed', sent: 0, failed: 1 });
    expect(dbMock.set).toHaveBeenLastCalledWith({ ocrCorrectionsReportedAt: null });
    expect(ackCalls(fetchImpl)).toHaveLength(0);
  });

  it('releases the claim when some failures were permanent but one could still land', async () => {
    dbMock.findFirst.mockResolvedValueOnce(expense([receipt({ ocrData: bothFieldsWrong })]));
    fetchImpl
      .mockResolvedValueOnce({ ok: false, status: 422 })
      .mockResolvedValue({ ok: false, status: 503 });

    const res = await reportOcrCorrectionsForExpense('exp-1');

    expect(res).toMatchObject({ status: 'send_failed', sent: 0, failed: 2 });
    expect(dbMock.set).toHaveBeenLastCalledWith({ ocrCorrectionsReportedAt: null });
    expect(ackCalls(fetchImpl)).toHaveLength(0);
  });

  it('releases the claim when one field landed and another can still be retried', async () => {
    dbMock.findFirst.mockResolvedValueOnce(expense([receipt({ ocrData: bothFieldsWrong })]));
    fetchImpl
      .mockResolvedValueOnce(okResponse)
      .mockResolvedValue({ ok: false, status: 500 });

    const res = await reportOcrCorrectionsForExpense('exp-1');

    // Keeping the claim here would lose the field that did not land, forever.
    // Re-sending the one that did is harmless: since OCR service 0.21.0 the
    // corrections table is UNIQUE (request_id, field) and the insert is
    // ON CONFLICT DO NOTHING.
    expect(res).toMatchObject({ status: 'send_failed', sent: 1, failed: 1 });
    expect(dbMock.set).toHaveBeenLastCalledWith({ ocrCorrectionsReportedAt: null });
    expect(ackCalls(fetchImpl)).toHaveLength(0);
  });

  // Both backfills key off ocr_corrections_reported_at: a receipt that keeps a
  // stamp it should not have is refused by ocr:backfill-corrections as
  // already_reported and then acked by ocr:backfill-reviewed — a transient
  // fault turned into a permanent "right first time". So on every path where
  // the claim could not come off, the ack must not be sent and the row must be
  // findable by hand.
  it('sends no ack and logs the ids for manual repair when the release UPDATE itself fails', async () => {
    dbMock.findFirst.mockResolvedValueOnce(expense([receipt()]));
    fetchImpl.mockRejectedValue(new Error('ECONNRESET'));
    dbMock.where
      .mockImplementationOnce(() => Object.assign(Promise.resolve(undefined), { returning: dbMock.returning }))
      .mockImplementationOnce(() => Object.assign(Promise.reject(new Error('pool exhausted')), { returning: dbMock.returning }));

    const res = await reportOcrCorrectionsForExpense('exp-1');

    expect(res).toMatchObject({ status: 'send_failed', sent: 0, failed: 1 });
    expect(ackCalls(fetchImpl)).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [payload] = vi.mocked(logger.error).mock.calls[0];
    // Ids and field names only — no merchant, amount, date or token.
    expect(payload).toMatchObject({ expenseId: 'exp-1', receiptId: 'rec-1', requestId: 'req-1' });
    expect(JSON.stringify(payload)).not.toContain('Uline');
  });

  // JSON.stringify of the request body is the one step inside sendCorrections
  // that sits outside the per-field try/catch. A BigInt date value is the
  // cheapest way to reach it: normalizeDate only String()s the value, so the
  // BigInt survives the diff and then cannot be serialized. It stands in for
  // anything that could ever throw between the claim and the ack — a malformed
  // OCR_BASE_URL, an abort raised between fields — all of which would
  // otherwise leave a stamped receipt with no corrections and no way back.
  it('releases the claim and sends no ack when the send path throws outright', async () => {
    dbMock.findFirst.mockResolvedValueOnce(expense([receipt({
      ocrData: { fields: { date: { value: 1n as unknown as string } } },
    })]));

    const res = await reportOcrCorrectionsForExpense('exp-1');

    expect(res).toMatchObject({ status: 'send_failed', sent: 0, failed: 1 });
    expect(dbMock.set).toHaveBeenLastCalledWith({ ocrCorrectionsReportedAt: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps the claim when every field landed', async () => {
    dbMock.findFirst.mockResolvedValueOnce(expense([receipt({ ocrData: bothFieldsWrong })]));

    const res = await reportOcrCorrectionsForExpense('exp-1');

    expect(res).toMatchObject({ status: 'reported', sent: 2, failed: 0 });
    expect(dbMock.set).toHaveBeenCalledExactlyOnceWith({ ocrCorrectionsReportedAt: expect.any(Date) });
    expect(ackCalls(fetchImpl)).toHaveLength(1);
  });

  it('posts the ack when there are no corrections — a clean review is still the signal', async () => {
    dbMock.findFirst.mockResolvedValueOnce(expense([receipt({ ocrData: { fields: { amount: { value: '97.20', source: 'llm' } } } })]));

    const res = await reportOcrCorrectionsForExpense('exp-1');

    expect(res).toEqual({ status: 'reported', corrections: [], sent: 0, failed: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://ocr.test/ocr/corrections/reviewed');
    expect(JSON.parse(init.body)).toEqual({ request_id: 'req-1' });
  });

  it('posts both the correction and the ack when the receipt was corrected', async () => {
    dbMock.findFirst.mockResolvedValueOnce(expense([receipt()]));

    const res = await reportOcrCorrectionsForExpense('exp-1');

    expect(res).toMatchObject({ status: 'reported', sent: 1, failed: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [correctionUrl] = fetchImpl.mock.calls[0];
    const [ackUrl, ackInit] = fetchImpl.mock.calls[1];
    expect(correctionUrl).toBe('http://ocr.test/ocr/corrections');
    expect(ackUrl).toBe('http://ocr.test/ocr/corrections/reviewed');
    expect(JSON.parse(ackInit.body)).toEqual({ request_id: 'req-1' });
  });

  it('swallows a 404 from the ack route (an older OCR service without it): no throw, no change to status, claim or corrections', async () => {
    dbMock.findFirst.mockResolvedValueOnce(expense([receipt()]));
    fetchImpl
      .mockResolvedValueOnce(okResponse) // correction
      .mockResolvedValueOnce({ ok: false, status: 404, body: { cancel: vi.fn().mockResolvedValue(undefined) } }); // ack

    const res = await reportOcrCorrectionsForExpense('exp-1');

    expect(res).toMatchObject({ status: 'reported', corrections: [{ field: 'amount', original_value: '9.72', corrected_value: '97.20' }], sent: 1, failed: 0 });
    expect(dbMock.set).toHaveBeenCalledExactlyOnceWith({ ocrCorrectionsReportedAt: expect.any(Date) });
  });

  it.each([503, 500])('swallows a %i from the ack route without affecting the result', async (status) => {
    dbMock.findFirst.mockResolvedValueOnce(expense([receipt()]));
    fetchImpl
      .mockResolvedValueOnce(okResponse)
      .mockResolvedValueOnce({ ok: false, status, body: { cancel: vi.fn().mockResolvedValue(undefined) } });

    const res = await reportOcrCorrectionsForExpense('exp-1');

    expect(res).toMatchObject({ status: 'reported', sent: 1, failed: 0 });
    expect(dbMock.set).toHaveBeenCalledExactlyOnceWith({ ocrCorrectionsReportedAt: expect.any(Date) });
  });

  it('swallows a network error on the ack without affecting the result', async () => {
    dbMock.findFirst.mockResolvedValueOnce(expense([receipt()]));
    fetchImpl
      .mockResolvedValueOnce(okResponse)
      .mockRejectedValueOnce(new Error('ECONNRESET'));

    const res = await reportOcrCorrectionsForExpense('exp-1');

    expect(res).toMatchObject({ status: 'reported', sent: 1, failed: 0 });
    expect(dbMock.set).toHaveBeenCalledExactlyOnceWith({ ocrCorrectionsReportedAt: expect.any(Date) });
  });

  it('skips entirely when the OCR service is not configured', async () => {
    env.OCR_MODE = 'mock';

    const res = await reportOcrCorrectionsForExpense('exp-1');

    expect(res).toEqual({ status: 'skipped', reason: 'ocr_service_not_configured', corrections: [], sent: 0, failed: 0 });
    expect(dbMock.findFirst).not.toHaveBeenCalled();
  });

  it('computes corrections without sending or stamping in dry-run mode (and sends no ack)', async () => {
    dbMock.findFirst.mockResolvedValueOnce(expense([receipt()]));

    const res = await reportOcrCorrectionsForExpense('exp-1', { dryRun: true });

    expect(res).toEqual({
      status: 'dry_run',
      corrections: [{ field: 'amount', original_value: '9.72', corrected_value: '97.20' }],
      sent: 0,
      failed: 0,
    });
    // Never called at all — proves neither the correction POST nor the reviewed ack fires.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  afterEach(() => {
    env.OCR_MODE = 'service';
    vi.unstubAllGlobals();
  });
});

// A query the driver rejects would be swallowed by the reporter's top-level
// catch and look like a permanent "no corrections" — so compile the real
// query config the reporter builds and check it asks for one receipt.
describe('first-receipt query', () => {
  it('orders by (uploaded_at, id) and limits to the first receipt', async () => {
    vi.clearAllMocks();
    dbMock.findFirst.mockResolvedValueOnce(undefined);
    await reportOcrCorrectionsForExpense('exp-1');

    const config = dbMock.findFirst.mock.calls[0][0];
    // A client that is never queried: toSQL() only compiles the query.
    const realDb = drizzle({ query: () => Promise.resolve({ rows: [] }) } as never, { schema });
    const { sql, params } = realDb.query.expenses.findFirst(config).toSQL();

    expect(sql).toContain('order by "expenses_receipts"."uploaded_at" asc, "expenses_receipts"."id" asc limit $');
    expect(sql).toContain('"expenses_receipts"."ocr_corrections_reported_at"');
    expect(params).toContain('exp-1');
  });
});
