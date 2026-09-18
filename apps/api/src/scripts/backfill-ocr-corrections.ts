/**
 * Report OCR corrections for expenses submitted (updated) in the last N days
 * (default 90).
 *
 *   --dry-run   compute and print counts; send nothing, claim nothing, write nothing
 *   --days=N    look-back window (default 90)
 *
 * Usage:
 *   npm run ocr:backfill-corrections -w @midas/api -- [--dry-run] [--days=90]
 *   node dist/scripts/backfill-ocr-corrections.js [--dry-run] [--days=90]
 *
 * Expenses are processed one at a time, never Promise.all'd: each call to
 * reportOcrCorrectionsForExpense can make several sequential POSTs to the OCR
 * service on its own, and fanning that out across many expenses at once would
 * multiply the load on a service this backfill is specifically meant to be
 * gentle with.
 *
 * reportOcrCorrectionsForExpense's result status is one of:
 *   'reported'    stamped; corrections were sent (or there were none to send)
 *   'rejected'    the OCR service permanently refused every correction
 *                 (401/404/422) — claim is KEPT so it is never retried
 *   'send_failed' every send failed with a retryable error (network/timeout/
 *                 429/5xx) — claim was RELEASED so a later run can retry it
 *   'dry_run'     computed only; nothing claimed, sent, or written
 *   'skipped'     see `reason`: no_receipt, first_receipt_not_scanned,
 *                 already_reported, no_ocr_fields, ocr_service_not_configured,
 *                 expense_not_found, error
 *
 * 'rejected' and 'send_failed' are counted separately from 'reported' in the
 * summary below — a run where nothing actually landed must not read like a
 * clean pass just because nothing threw.
 */
import { and, gte, notInArray } from 'drizzle-orm';

import { db } from '../db/index';
import { expenses } from '../db/schema';
import { reportOcrCorrectionsForExpense } from '../lib/reportOcrCorrections';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const days = Number(args.find((a) => a.startsWith('--days='))?.split('=')[1] ?? 90);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// How often to log progress on a long run, and how long to pause between
// expenses whose corrections were actually sent (live mode only) so the
// backfill doesn't stampede the OCR service.
const PROGRESS_INTERVAL = 50;
const SEND_PAUSE_MS = 50;

async function run() {
  if (!Number.isFinite(days) || days <= 0) {
    console.error(`Invalid --days value (${JSON.stringify(process.argv.slice(2))}); must be a positive number.`);
    process.exit(1);
    return;
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ id: expenses.id })
    .from(expenses)
    .where(and(gte(expenses.updatedAt, since), notInArray(expenses.status, ['draft', 'cancelled'])));

  console.log(
    `[ocr:backfill-corrections] mode=${dryRun ? 'dry-run' : 'live'} days=${days} since=${since.toISOString()} expenses=${rows.length}`,
  );

  const totals = {
    expenses: rows.length,
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
  const byField: Record<string, number> = {};
  const skipReasons: Record<string, number> = {};

  let processed = 0;
  for (const { id } of rows) {
    const r = await reportOcrCorrectionsForExpense(id, { dryRun });

    if (r.status === 'skipped') {
      totals.skipped++;
      const reason = r.reason ?? 'unknown';
      skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
    } else {
      // 'reported' | 'rejected' | 'send_failed' | 'dry_run' — every one of
      // these carries corrections/sent/failed, so roll those up regardless
      // of which bucket the status itself falls into.
      if (r.status === 'reported') totals.reported++;
      else if (r.status === 'rejected') totals.rejected++;
      else if (r.status === 'send_failed') totals.sendFailed++;
      else if (r.status === 'dry_run') totals.dryRun++;

      if (r.corrections.length) totals.withCorrections++;
      totals.corrections += r.corrections.length;
      totals.sent += r.sent;
      totals.failed += r.failed;
      for (const c of r.corrections) byField[c.field] = (byField[c.field] ?? 0) + 1;

      if (!dryRun && r.corrections.length) await sleep(SEND_PAUSE_MS);
    }

    processed++;
    if (processed % PROGRESS_INTERVAL === 0 || processed === rows.length) {
      console.log(`[ocr:backfill-corrections] processed ${processed}/${rows.length}`);
    }
  }

  console.log(
    JSON.stringify(
      { mode: dryRun ? 'dry-run' : 'live', days, ...totals, byField, skipReasons },
      null,
      2,
    ),
  );
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
