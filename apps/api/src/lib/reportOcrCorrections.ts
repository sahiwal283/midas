/**
 * Report user corrections of OCR fields to the OCR service so it can measure
 * accuracy. Never throws into callers; safe to fire-and-forget from submit.
 *
 * The OCR service stores every correction it is handed — it has no unique key
 * on (request_id, field) and de-duplicates nothing. So a correction must be
 * sent at most once: `receipts.ocr_corrections_reported_at` is claimed before
 * sending, and released again only if nothing at all landed.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';

import { env } from '../config/env';
import { db } from '../db/index';
import { expenses, receipts } from '../db/schema';
import { logger } from './logger';
import { diffOcrCorrections } from './ocrCorrections';
import type { Correction, CorrectableField, OcrFieldLike } from './ocrCorrections';

function serviceConfigured(): boolean {
  return env.OCR_MODE === 'service' && Boolean(env.OCR_BASE_URL) && Boolean(env.OCR_SERVICE_INTERNAL_TOKEN);
}

function message(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

/** 4xx means the service will reject this correction just as hard next time. */
function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
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

    // Claim the receipt before sending. The conditional update is the only
    // thing standing between a concurrent resubmit and double-counted
    // corrections, since the service de-duplicates nothing.
    const claimedAt = new Date();
    const claimed = await db.update(receipts)
      .set({ ocrCorrectionsReportedAt: claimedAt })
      .where(and(eq(receipts.id, receipt.id), isNull(receipts.ocrCorrectionsReportedAt)))
      .returning({ id: receipts.id });
    if (!claimed.length) return { status: 'skipped', reason: 'already_reported', ...empty };

    if (!corrections.length) return { status: 'reported', corrections, sent: 0, failed: 0 };

    const { sent, failed, retryableFields, rejectedFields } = await sendCorrections(receipt.ocrRequestId, corrections);
    if (sent === 0 && retryableFields.length) {
      // Nothing landed and at least one field could still land: release our own
      // claim (never a newer one) and let the backfill retry this receipt.
      await db.update(receipts)
        .set({ ocrCorrectionsReportedAt: null })
        .where(and(eq(receipts.id, receipt.id), eq(receipts.ocrCorrectionsReportedAt, claimedAt)));
      logger.warn({ expenseId, requestId: receipt.ocrRequestId, failed, retryableFields, rejectedFields }, 'OCR correction reporting failed; receipt left unreported for retry');
      return { status: 'send_failed', corrections, sent, failed };
    }
    if (rejectedFields.length) {
      // Stays claimed: the service refused these outright, so retrying them on
      // every backfill run would only repeat the refusal.
      logger.warn({ expenseId, requestId: receipt.ocrRequestId, rejectedFields }, 'OCR service refused some corrections');
    }
    if (retryableFields.length) {
      // Stays claimed: a retry would double-count the fields that did land.
      logger.warn({ expenseId, requestId: receipt.ocrRequestId, retryableFields }, 'Some OCR corrections were not reported');
    }
    if (sent === 0) return { status: 'rejected', corrections, sent, failed };
    logger.info({ expenseId, requestId: receipt.ocrRequestId, sent, failed }, 'Reported OCR corrections');
    return { status: 'reported', corrections, sent, failed };
  } catch (err) {
    logger.warn({ expenseId, err: message(err) }, 'OCR correction reporting skipped after error');
    return { status: 'skipped', reason: 'error', ...empty };
  }
}
