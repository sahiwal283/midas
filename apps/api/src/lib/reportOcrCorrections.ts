/**
 * Report user corrections of OCR fields to the OCR service so it can measure
 * accuracy. Never throws into callers; safe to fire-and-forget from submit.
 */
import { asc, eq } from 'drizzle-orm';

import { env } from '../config/env';
import { db } from '../db/index';
import { expenses, receipts } from '../db/schema';
import { logger } from './logger';
import { diffOcrCorrections } from './ocrCorrections';
import type { Correction, CorrectableField, OcrFieldLike } from './ocrCorrections';

function serviceConfigured(): boolean {
  return env.OCR_MODE === 'service' && Boolean(env.OCR_BASE_URL) && Boolean(env.OCR_SERVICE_INTERNAL_TOKEN);
}

export async function sendCorrections(
  requestId: string,
  corrections: Correction[],
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<{ sent: number; failed: number }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let sent = 0;
  let failed = 0;
  for (const c of corrections) {
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': env.OCR_SERVICE_INTERNAL_TOKEN ?? '',
        'X-Client-App': env.OCR_CLIENT_APP ?? 'midas',
      },
      body: JSON.stringify({ request_id: requestId, field: c.field, original_value: c.original_value, corrected_value: c.corrected_value }),
    };
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        const res = await fetchImpl(`${env.OCR_BASE_URL}/ocr/corrections`, init);
        ok = res.ok;
        if (!ok) logger.warn({ requestId, field: c.field, status: res.status, attempt }, 'OCR correction report rejected');
      } catch (err) {
        logger.warn({ requestId, field: c.field, attempt, err: (err as Error).message }, 'OCR correction report failed');
      }
    }
    if (ok) sent++;
    else failed++;
  }
  return { sent, failed };
}

export async function reportOcrCorrectionsForExpense(
  expenseId: string,
  opts: { dryRun?: boolean } = {},
): Promise<{ status: 'skipped' | 'reported' | 'dry_run'; reason?: string; corrections: Correction[]; sent: number; failed: number }> {
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

    const { sent, failed } = corrections.length
      ? await sendCorrections(receipt.ocrRequestId, corrections)
      : { sent: 0, failed: 0 };
    await db.update(receipts).set({ ocrCorrectionsReportedAt: new Date() }).where(eq(receipts.id, receipt.id));
    if (corrections.length) logger.info({ expenseId, requestId: receipt.ocrRequestId, sent, failed }, 'Reported OCR corrections');
    return { status: 'reported', corrections, sent, failed };
  } catch (err) {
    logger.warn({ expenseId, err: (err as Error).message }, 'OCR correction reporting skipped after error');
    return { status: 'skipped', reason: 'error', ...empty };
  }
}
