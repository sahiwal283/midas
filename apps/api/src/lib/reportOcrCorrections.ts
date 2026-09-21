/**
 * Report user corrections of OCR fields to the OCR service so it can measure
 * accuracy. Never throws into callers; safe to fire-and-forget from submit.
 *
 * Since OCR service 0.21.0 the corrections table is UNIQUE (request_id, field)
 * and the insert is ON CONFLICT DO NOTHING, so re-sending a correction that
 * already landed is a no-op rather than a duplicate row.
 * `receipts.ocr_corrections_reported_at` is still claimed before sending — it
 * is what keeps a concurrent resubmit from reporting the same receipt twice,
 * and what tells the backfill which receipts still need reporting — but it is
 * released again whenever any field could still land, so the backfill can
 * redeliver the whole receipt.
 *
 * The reviewed ack is sent only once this receipt's reporting is finished with
 * nothing outstanding: no corrections to make, or every correction delivered
 * or permanently refused. A receipt with a correction still to land is never
 * acked — not when its claim was released for redelivery, and not when the
 * release itself failed — because an ack without that correction tells the
 * service the job was reviewed and found right first time, corrupting the
 * exact figure this reporting exists to measure.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';

import { env } from '../config/env';
import { db } from '../db/index';
import { expenses, receipts } from '../db/schema';
import { logger } from './logger';
import { diffOcrCorrections } from './ocrCorrections';
import type { Correction, CorrectableField, OcrFieldLike } from './ocrCorrections';

/** Exported for `ocr:backfill-reviewed`, which must not POST into the void. */
export function serviceConfigured(): boolean {
  return env.OCR_MODE === 'service' && Boolean(env.OCR_BASE_URL) && Boolean(env.OCR_SERVICE_INTERNAL_TOKEN);
}

function message(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

/**
 * Most 4xx means the service will reject this correction just as hard next
 * time. But 401/403/404/408/425 are configuration or transport states that
 * get fixed — a rotated OCR_SERVICE_INTERNAL_TOKEN, a flipped
 * OCR_REQUIRE_SERVICE_TOKEN, a route-prefix change, a proxy timeout — and
 * treating them as permanent would keep the claim forever, silently and
 * irreversibly destroying corrections for every submit in that window (and
 * masquerading as an improved first-time-right rate). So these must stay
 * retryable. Only 400 (malformed body) and 422 (unknown field name) are
 * genuinely permanent.
 */
function retryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status === 425 || status === 401 || status === 403 || status === 404 || status >= 500;
}

/**
 * OCR_TIMEOUT_MS (120s) is sized for uploading a receipt image. This is a small
 * JSON POST per corrected field, and the loop is sequential: at 120s a five-field
 * receipt could stay claimed for ~20 minutes, and a deploy inside that window
 * would destroy the corrections outright.
 */
const CORRECTION_TIMEOUT_MS = Math.min(env.OCR_TIMEOUT_MS, 10_000);

export interface SendOutcome {
  sent: number;
  failed: number;
  /** Fields that could still land later: transport error, 429 or 5xx. */
  retryableFields: CorrectableField[];
  /** Fields the service refused outright — retrying these never helps. */
  rejectedFields: { field: CorrectableField; status: number }[];
}

export async function sendCorrections(
  requestId: string,
  corrections: Correction[],
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<SendOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const headers = {
    'Content-Type': 'application/json',
    'X-Internal-Token': env.OCR_SERVICE_INTERNAL_TOKEN ?? '',
    'X-Client-App': env.OCR_CLIENT_APP ?? 'midas',
  };
  let sent = 0;
  const retryableFields: CorrectableField[] = [];
  const rejectedFields: { field: CorrectableField; status: number }[] = [];

  for (const c of corrections) {
    const body = JSON.stringify({ request_id: requestId, field: c.field, original_value: c.original_value, corrected_value: c.corrected_value });
    let ok = false;
    let refusedWith: number | null = null;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(new Error('timeout')), CORRECTION_TIMEOUT_MS);
      try {
        const res = await fetchImpl(`${env.OCR_BASE_URL}/ocr/corrections`, { method: 'POST', headers, body, signal: controller.signal });
        ok = res.ok;
        // Nothing reads the body, and undici holds the connection open until
        // it is consumed or cancelled.
        try { await res.body?.cancel(); } catch { /* connection already gone */ }
        if (!ok) {
          logger.warn({ requestId, field: c.field, status: res.status, attempt }, 'OCR correction report rejected');
          if (!retryableStatus(res.status)) {
            refusedWith = res.status;
            break;
          }
        }
      } catch (err) {
        logger.warn({ requestId, field: c.field, attempt, err: message(err) }, 'OCR correction report failed');
      } finally {
        clearTimeout(timeoutId);
      }
    }
    if (ok) sent++;
    else if (refusedWith !== null) rejectedFields.push({ field: c.field, status: refusedWith });
    else retryableFields.push(c.field);
  }

  return { sent, failed: retryableFields.length + rejectedFields.length, retryableFields, rejectedFields };
}

/**
 * Acknowledge that Midas reviewed this receipt — corrections or not. The OCR
 * service's first-time-right denominator only counts jobs it has an ack for,
 * so a clean review (no corrections) is exactly as important to report as a
 * corrected one. Best-effort, no retry: a lost ack costs one job in the
 * denominator, never a submit. Never throws — every failure (transport,
 * non-2xx, an older OCR service that 404s on this route) is logged and
 * swallowed here so it can never affect status, the claim, or the
 * corrections flow. Resolves true only when the service accepted the ack: the
 * submit path ignores that, `ocr:backfill-reviewed` counts it.
 */
export async function sendReviewedAck(
  requestId: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const headers = {
    'Content-Type': 'application/json',
    'X-Internal-Token': env.OCR_SERVICE_INTERNAL_TOKEN ?? '',
    'X-Client-App': env.OCR_CLIENT_APP ?? 'midas',
  };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error('timeout')), CORRECTION_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${env.OCR_BASE_URL}/ocr/corrections/reviewed`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ request_id: requestId }),
      signal: controller.signal,
    });
    // Nothing reads the body, and undici holds the connection open until it
    // is consumed or cancelled.
    try { await res.body?.cancel(); } catch { /* connection already gone */ }
    if (!res.ok) {
      logger.warn({ requestId, status: res.status }, 'OCR reviewed ack rejected');
    }
    return res.ok;
  } catch (err) {
    logger.warn({ requestId, err: message(err) }, 'OCR reviewed ack failed');
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function reportOcrCorrectionsForExpense(
  expenseId: string,
  opts: { dryRun?: boolean } = {},
): Promise<{ status: 'skipped' | 'reported' | 'rejected' | 'send_failed' | 'dry_run'; reason?: string; corrections: Correction[]; sent: number; failed: number }> {
  const empty = { corrections: [] as Correction[], sent: 0, failed: 0 };
  try {
    if (!serviceConfigured()) return { status: 'skipped', reason: 'ocr_service_not_configured', ...empty };

    const expense = await db.query.expenses.findFirst({
      where: eq(expenses.id, expenseId),
      with: {
        receipts: {
          orderBy: [asc(receipts.uploadedAt), asc(receipts.id)],
          limit: 1,
        },
        category: { columns: { name: true } },
        paymentMethod: { columns: { lastFour: true } },
      },
    });
    if (!expense) return { status: 'skipped', reason: 'expense_not_found', ...empty };
    // Only the first receipt prefills the form, so it is the only one worth
    // diffing — a later scan would invent corrections the user never made.
    const receipt = expense.receipts[0];
    if (!receipt) return { status: 'skipped', reason: 'no_receipt', ...empty };
    if (!receipt.ocrRequestId || receipt.ocrStatus !== 'done') {
      return { status: 'skipped', reason: 'first_receipt_not_scanned', ...empty };
    }
    if (receipt.ocrCorrectionsReportedAt) return { status: 'skipped', reason: 'already_reported', ...empty };

    const data = receipt.ocrData as { fields?: Partial<Record<CorrectableField, OcrFieldLike>> } | null;
    if (!data?.fields) return { status: 'skipped', reason: 'no_ocr_fields', ...empty };

    const corrections = diffOcrCorrections(data.fields, {
      merchant: expense.merchant,
      amount: String(expense.amount),
      date: String(expense.date),
      categoryName: expense.category?.name ?? null,
      cardLastFour: expense.paymentMethod?.lastFour ?? null,
    });

    if (opts.dryRun) return { status: 'dry_run', corrections, sent: 0, failed: 0 };

    // Claim the receipt before sending. The conditional update is what stands
    // between a concurrent resubmit and a second round of reporting for the
    // same receipt; the service's idempotent insert is only the backstop if
    // the two ever overlap.
    const claimedAt = new Date();
    const claimed = await db.update(receipts)
      .set({ ocrCorrectionsReportedAt: claimedAt })
      .where(and(eq(receipts.id, receipt.id), isNull(receipts.ocrCorrectionsReportedAt)))
      .returning({ id: receipts.id });
    if (!claimed.length) return { status: 'skipped', reason: 'already_reported', ...empty };

    // Midas reviewed this receipt and found nothing to correct, so reporting
    // it is already final: ack the clean review — it is exactly as much of a
    // signal as a corrected one. Fired after the claim, never before, and its
    // outcome is discarded: it must never change status, the claim, or the
    // corrections result.
    if (!corrections.length) {
      await sendReviewedAck(receipt.ocrRequestId);
      return { status: 'reported', corrections, sent: 0, failed: 0 };
    }

    let outcome: SendOutcome;
    try {
      outcome = await sendCorrections(receipt.ocrRequestId, corrections);
    } catch (err) {
      // sendCorrections handles every per-field failure itself, so a throw
      // here came from outside that loop. Whatever it was, nothing can be
      // assumed to have landed — fall through to the release below, because
      // the one outcome that must never happen is a stamped receipt whose
      // corrections were never delivered.
      logger.warn({ expenseId, requestId: receipt.ocrRequestId, err: message(err) }, 'OCR correction sending threw; treating every field as unsent');
      outcome = { sent: 0, failed: corrections.length, retryableFields: corrections.map((c) => c.field), rejectedFields: [] };
    }
    const { sent, failed, retryableFields, rejectedFields } = outcome;

    if (retryableFields.length) {
      // At least one field could still land: release our own claim (never a
      // newer one) so `ocr:backfill-corrections` can redeliver this receipt.
      // The fields that did land are re-sent on that run and the service
      // discards them (UNIQUE (request_id, field), ON CONFLICT DO NOTHING) —
      // far cheaper than keeping the claim, which would drop the fields that
      // did not land, permanently and invisibly.
      try {
        await db.update(receipts)
          .set({ ocrCorrectionsReportedAt: null })
          .where(and(eq(receipts.id, receipt.id), eq(receipts.ocrCorrectionsReportedAt, claimedAt)));
        logger.warn({ expenseId, requestId: receipt.ocrRequestId, sent, failed, retryableFields, rejectedFields }, 'OCR correction reporting incomplete; receipt left unreported for retry');
      } catch (err) {
        // The stamp is still on the row: `ocr:backfill-corrections` will
        // refuse this receipt as already_reported and `ocr:backfill-reviewed`
        // would ack it, scoring a lost correction as right-first-time. Nothing
        // in code can fix that — the DB is the thing that just failed — so log
        // the ids at error level (no user data) to make the row repairable by
        // hand: clear ocr_corrections_reported_at and re-run the backfill.
        logger.error({ expenseId, receiptId: receipt.id, requestId: receipt.ocrRequestId, retryableFields, err: message(err) }, 'Failed to release OCR corrections claim; receipt stays stamped and must be cleared by hand');
      }
      // Deliberately no ack, released or not: with corrections outstanding, an
      // ack here is precisely the false "right first time" this module exists
      // to prevent. A successful release gets its ack from the redelivery.
      return { status: 'send_failed', corrections, sent, failed };
    }

    // The claim is kept from here on, so reporting this receipt is final —
    // ack the review, corrections or not. The ack's outcome is discarded: it
    // must never change status, the claim, or the corrections result.
    await sendReviewedAck(receipt.ocrRequestId);
    if (rejectedFields.length) {
      // Stays claimed: the service refused these outright, so retrying them on
      // every backfill run would only repeat the refusal.
      logger.warn({ expenseId, requestId: receipt.ocrRequestId, rejectedFields }, 'OCR service refused some corrections');
    }
    if (sent === 0) return { status: 'rejected', corrections, sent, failed };
    logger.info({ expenseId, requestId: receipt.ocrRequestId, sent, failed }, 'Reported OCR corrections');
    return { status: 'reported', corrections, sent, failed };
  } catch (err) {
    logger.warn({ expenseId, err: message(err) }, 'OCR correction reporting skipped after error');
    return { status: 'skipped', reason: 'error', ...empty };
  }
}
