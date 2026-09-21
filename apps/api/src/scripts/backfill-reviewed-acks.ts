/**
 * Acknowledge every receipt Midas has already reviewed to the OCR service, so
 * its first-time-right figure covers the history as well as new traffic.
 *
 * Why this exists: the OCR service counts a job as *considered* when it was
 * acknowledged OR has a correction. Acks only started with Midas 1.15.0, so
 * without this backfill every older receipt that needed a correction is in the
 * denominator while its clean siblings — the ones that were right first time —
 * can never get there. The console would read close to 0% accurate on day one
 * and drift up to the truth over a month, then publish the drift as an
 * improvement that never happened.
 *
 * Midas holds the authoritative record of what it reviewed:
 * `receipts.ocr_corrections_reported_at` has been stamped at claim time for
 * every reviewed first-image receipt since 1.14.0, whether or not anything
 * needed correcting. That is exactly the set acked here.
 *
 *   --dry-run   count the receipts and print the summary; send nothing
 *   --days=N    only receipts claimed in the last N days (default: all of them)
 *
 * Usage:
 *   npm run ocr:backfill-reviewed -w @midas/api -- [--dry-run] [--days=N]
 *   node dist/scripts/backfill-reviewed-acks.js [--dry-run] [--days=N]
 *
 * Safe to re-run: the OCR service's ack route keys on the request id alone
 * (`ocr_reviewed_jobs.request_id` is the primary key), so a second ack for the
 * same job is a no-op. A run interrupted halfway can simply be run again.
 *
 * Receipts are acked one at a time, never Promise.all'd, with the same pause
 * between sends as `ocr:backfill-corrections` — this walks the whole history
 * at once and must stay gentle with the service it is measuring.
 *
 * Exit codes:
 *   0  normal run — includes any --dry-run, a run with nothing to do, and a
 *      live run where at least some acks landed (even if others failed)
 *   1  invalid arguments (bad --days), the OCR service is not configured, or
 *      an unhandled error before/while running
 *   2  live run only: zero acks landed and at least one failed — i.e. nothing
 *      landed at all. A WARN line is also printed to stderr (separate from the
 *      JSON on stdout) whenever any ack failed, even if others landed and the
 *      exit code is still 0, so a caller piping stdout to `jq` still sees the
 *      problem on the terminal.
 */
import { and, eq, gte, isNotNull } from 'drizzle-orm';

import { db } from '../db/index';
import { receipts } from '../db/schema';
import { sendReviewedAck, serviceConfigured } from '../lib/reportOcrCorrections';

export interface Totals {
  receipts: number;
  acked: number;
  failed: number;
}

/**
 * Pure aggregation of one run's per-receipt ack outcomes (true = the service
 * accepted it) into the JSON a human reads afterward — this is the trust
 * boundary for a production run, so it takes no DB/network dependency and is
 * unit-tested directly (see __tests__/backfill-reviewed-acks.test.ts).
 *
 * `receiptCount` comes from the query rather than `results.length`: a dry run
 * produces no results at all, and a run cut short must not report a smaller
 * population than it actually selected.
 */
export function summarize(receiptCount: number, results: boolean[]): Totals {
  let acked = 0;
  let failed = 0;
  for (const ok of results) {
    if (ok) acked++;
    else failed++;
  }
  return { receipts: receiptCount, acked, failed };
}

/**
 * 2 only for a live run where nothing landed at all (zero acked, at least one
 * failure) — a wrapper checking `$?` must not see success. Dry runs always
 * exit 0: nothing was ever attempted, so there is nothing to report as failed.
 */
export function determineExitCode(totals: Totals, dryRun: boolean): number {
  if (dryRun) return 0;
  if (totals.failed > 0 && totals.acked === 0) return 2;
  return 0;
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const daysArg = args.find((a) => a.startsWith('--days='))?.split('=')[1];
const days = daysArg === undefined ? null : Number(daysArg);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// How often to log progress on a long run, and how long to pause between acks
// (live mode only) so the backfill doesn't stampede the OCR service.
const PROGRESS_INTERVAL = 50;
const SEND_PAUSE_MS = 50;

async function run() {
  if (days !== null && (!Number.isFinite(days) || days <= 0)) {
    console.error(`Invalid --days value (${JSON.stringify(args)}); must be a positive number.`);
    process.exit(1);
    return;
  }
  if (!serviceConfigured()) {
    console.error('OCR service is not configured (OCR_MODE=service, OCR_BASE_URL, OCR_SERVICE_INTERNAL_TOKEN); nothing to send.');
    process.exit(1);
    return;
  }

  const since = days === null ? null : new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  // Every receipt Midas claimed for reporting is a receipt Midas reviewed:
  // stamped at claim time, first image only, OCR completed.
  const filters = [
    isNotNull(receipts.ocrCorrectionsReportedAt),
    isNotNull(receipts.ocrRequestId),
    eq(receipts.ocrStatus, 'done'),
  ];
  if (since) filters.push(gte(receipts.ocrCorrectionsReportedAt, since));

  const rows = await db
    .select({ id: receipts.id, requestId: receipts.ocrRequestId })
    .from(receipts)
    .where(and(...filters));
  // Narrowing only — the query already excludes null request ids.
  const targets = rows.filter((r): r is { id: string; requestId: string } => r.requestId !== null);

  console.log(
    `[ocr:backfill-reviewed] mode=${dryRun ? 'dry-run' : 'live'} days=${days ?? 'all'}` +
      `${since ? ` since=${since.toISOString()}` : ''} receipts=${targets.length}`,
  );

  const results: boolean[] = [];
  let processed = 0;
  for (const target of targets) {
    if (!dryRun) {
      results.push(await sendReviewedAck(target.requestId));
      await sleep(SEND_PAUSE_MS);
    }

    processed++;
    if (processed % PROGRESS_INTERVAL === 0 || processed === targets.length) {
      console.log(`[ocr:backfill-reviewed] processed ${processed}/${targets.length}`);
    }
  }

  const totals = summarize(targets.length, results);

  if (totals.failed > 0) {
    console.error(
      `[ocr:backfill-reviewed] WARN: ${totals.failed} receipt(s) were not acknowledged ` +
        `(acked=${totals.acked}, receipts=${totals.receipts}); re-run to retry them`,
    );
  }

  console.log(JSON.stringify({ mode: dryRun ? 'dry-run' : 'live', days: days ?? 'all', ...totals }, null, 2));
  process.exit(determineExitCode(totals, dryRun));
}

// Guarded so this module can be imported (e.g. by tests, for `summarize` and
// `determineExitCode`) without kicking off a real run against the DB/OCR
// service. `require.main === module` is only true when this file is the
// process entry point (tsx CLI, or `node dist/scripts/...js`).
if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
