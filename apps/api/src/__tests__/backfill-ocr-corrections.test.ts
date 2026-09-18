/**
 * Pure aggregation logic for the OCR corrections backfill script — the trust
 * boundary for the JSON a human reads after a production run. No DB, no
 * network: `summarize`/`determineExitCode` take synthetic
 * reportOcrCorrectionsForExpense results directly.
 */
import { describe, expect, it, vi } from 'vitest';

// The script module also imports `db` (which validates env at import time)
// and `reportOcrCorrectionsForExpense` (which imports env directly). Neither
// is used by the pure functions under test, so stub both out rather than
// requiring a real DB/OCR configuration just to import this file.
vi.mock('../db/index', () => ({ db: {} }));
vi.mock('../lib/reportOcrCorrections', () => ({ reportOcrCorrectionsForExpense: vi.fn() }));

import { determineExitCode, summarize, type Totals } from '../scripts/backfill-ocr-corrections';

type Result = Parameters<typeof summarize>[1][number];

const reported = (fields: string[] = [], sent = fields.length, failed = 0): Result =>
  ({ status: 'reported', corrections: fields.map((field) => ({ field })), sent, failed } as Result);
const rejected = (fields: string[], failed = fields.length): Result =>
  ({ status: 'rejected', corrections: fields.map((field) => ({ field })), sent: 0, failed } as Result);
const sendFailed = (fields: string[], failed = fields.length): Result =>
  ({ status: 'send_failed', corrections: fields.map((field) => ({ field })), sent: 0, failed } as Result);
const dryRunResult = (fields: string[] = []): Result =>
  ({ status: 'dry_run', corrections: fields.map((field) => ({ field })), sent: 0, failed: 0 } as Result);
const skipped = (reason: string): Result => ({ status: 'skipped', reason, corrections: [], sent: 0, failed: 0 } as Result);

describe('summarize', () => {
  it('rolls a mixed batch into mutually-exclusive reported/rejected/sendFailed/skipped counters', () => {
    const results = [
      reported(['merchant']),
      rejected(['amount']),
      sendFailed(['date']),
      skipped('no_receipt'),
      skipped('no_receipt'),
      reported([]),
    ];

    const { totals } = summarize(results.length, results);

    expect(totals).toEqual<Totals>({
      expenses: 6,
      reported: 2,
      rejected: 1,
      sendFailed: 1,
      dryRun: 0,
      skipped: 2,
      withCorrections: 3,
      corrections: 3,
      sent: 1,
      failed: 2,
    });
  });

  it('never counts a dry_run result as reported', () => {
    const results = [dryRunResult(['merchant']), dryRunResult([]), skipped('already_reported')];

    const { totals } = summarize(results.length, results);

    expect(totals.dryRun).toBe(2);
    expect(totals.reported).toBe(0);
    expect(totals.skipped).toBe(1);
  });

  it('tallies skip reasons by reason, including an unknown/undefined reason', () => {
    const results = [
      skipped('no_receipt'),
      skipped('no_receipt'),
      skipped('first_receipt_not_scanned'),
      skipped('already_reported'),
      { status: 'skipped', corrections: [], sent: 0, failed: 0 } as Result, // no `reason`
    ];

    const { skipReasons } = summarize(results.length, results);

    expect(skipReasons).toEqual({
      no_receipt: 2,
      first_receipt_not_scanned: 1,
      already_reported: 1,
      unknown: 1,
    });
  });

  it('counts withCorrections/corrections/byField only for expenses actually diffed, never for skipped ones', () => {
    const results = [
      reported(['merchant', 'amount']),
      rejected(['amount', 'date']),
      reported([]), // reported but nothing to correct — should not count toward withCorrections
      skipped('no_ocr_fields'),
    ];

    const { totals, byField } = summarize(results.length, results);

    expect(totals.withCorrections).toBe(2);
    expect(totals.corrections).toBe(4);
    expect(byField).toEqual({ merchant: 1, amount: 2, date: 1 });
  });

  it('returns all-zero totals for an empty batch', () => {
    const { totals, byField, skipReasons } = summarize(0, []);
    expect(totals).toEqual<Totals>({
      expenses: 0,
      reported: 0,
      rejected: 0,
      sendFailed: 0,
      dryRun: 0,
      skipped: 0,
      withCorrections: 0,
      corrections: 0,
      sent: 0,
      failed: 0,
    });
    expect(byField).toEqual({});
    expect(skipReasons).toEqual({});
  });
});

describe('determineExitCode', () => {
  const base: Totals = {
    expenses: 0,
    reported: 0,
    rejected: 0,
    sendFailed: 0,
    dryRun: 0,
    skipped: 0,
    withCorrections: 0,
    corrections: 0,
    sent: 0,
    failed: 0,
  };

  it('is 0 for a dry run no matter what the totals look like', () => {
    expect(determineExitCode({ ...base, rejected: 5 }, true)).toBe(0);
    expect(determineExitCode({ ...base, sendFailed: 5 }, true)).toBe(0);
  });

  it('is 0 for a live run with at least one reported, even alongside rejected/sendFailed', () => {
    expect(determineExitCode({ ...base, reported: 1, rejected: 3 }, false)).toBe(0);
    expect(determineExitCode({ ...base, reported: 1, sendFailed: 3 }, false)).toBe(0);
  });

  it('is 0 for a live run where everything was skipped (no attempts, no failures)', () => {
    expect(determineExitCode({ ...base, skipped: 10 }, false)).toBe(0);
  });

  it('is 2 for a live run where nothing landed: zero reported, at least one rejected or send_failed', () => {
    expect(determineExitCode({ ...base, rejected: 2 }, false)).toBe(2);
    expect(determineExitCode({ ...base, sendFailed: 2 }, false)).toBe(2);
    expect(determineExitCode({ ...base, rejected: 1, sendFailed: 1 }, false)).toBe(2);
  });
});
