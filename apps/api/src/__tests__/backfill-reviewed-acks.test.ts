/**
 * Pure aggregation logic for the reviewed-ack backfill script — the trust
 * boundary for the JSON a human reads after a production run. No DB, no
 * network: `summarize`/`determineExitCode` take synthetic per-receipt ack
 * outcomes directly.
 */
import { describe, expect, it, vi } from 'vitest';

// The script module also imports `db` (which validates env at import time) and
// the ack sender (which imports env directly). Neither is used by the pure
// functions under test, so stub both out rather than requiring a real DB/OCR
// configuration just to import this file.
vi.mock('../db/index', () => ({ db: {} }));
vi.mock('../lib/reportOcrCorrections', () => ({ sendReviewedAck: vi.fn(), serviceConfigured: vi.fn() }));

import { determineExitCode, summarize, type Totals } from '../scripts/backfill-reviewed-acks';

describe('summarize', () => {
  it('splits accepted acks from failed ones', () => {
    const results = [true, false, true, false, false];

    expect(summarize(results.length, results)).toEqual<Totals>({ receipts: 5, acked: 2, failed: 3 });
  });

  it('reports a dry run as zero acked and zero failed, since nothing was sent', () => {
    expect(summarize(12, [])).toEqual<Totals>({ receipts: 12, acked: 0, failed: 0 });
  });

  // The receipt count comes from the query, not the results: a run cut short
  // must not silently report a smaller population than it selected.
  it('keeps the selected receipt count even when fewer results came back', () => {
    expect(summarize(10, [true, true])).toEqual<Totals>({ receipts: 10, acked: 2, failed: 0 });
  });
});

describe('determineExitCode', () => {
  it('exits 2 when nothing landed and there were failures', () => {
    expect(determineExitCode({ receipts: 3, acked: 0, failed: 3 }, false)).toBe(2);
  });

  it('exits 0 when some acks landed despite failures', () => {
    expect(determineExitCode({ receipts: 3, acked: 1, failed: 2 }, false)).toBe(0);
  });

  it('exits 0 on a clean run and on an empty one', () => {
    expect(determineExitCode({ receipts: 3, acked: 3, failed: 0 }, false)).toBe(0);
    expect(determineExitCode({ receipts: 0, acked: 0, failed: 0 }, false)).toBe(0);
  });

  it('never fails a dry run: nothing was attempted, so nothing failed', () => {
    expect(determineExitCode({ receipts: 9, acked: 0, failed: 0 }, true)).toBe(0);
  });
});
