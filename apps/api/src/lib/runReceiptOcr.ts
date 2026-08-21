import path from 'path';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { receipts } from '../db/schema';
import { ocr, OcrAuthError } from './ocr';
import { env } from '../config/env';
import { pickReferenceNumber } from '@midas/shared';

/**
 * Runs OCR for a receipt and persists the result.
 * Used by the sync-primary upload path so the HTTP response includes OCR state.
 */
export async function runReceiptOcr(receiptId: string, storagePath: string): Promise<typeof receipts.$inferSelect> {
  const submittedAt = new Date();
  await db.update(receipts)
    .set({ ocrStatus: 'processing', ocrSubmittedAt: submittedAt })
    .where(eq(receipts.id, receiptId));

  try {
    const fullPath = path.join(env.UPLOADS_DIR, storagePath);
    const result = await ocr.process(fullPath, receiptId);
    const picked = pickReferenceNumber({
      field: result.fields.referenceNumber?.value,
      text: result.text,
    });
    if (picked) {
      const existing = result.fields.referenceNumber;
      result.fields.referenceNumber = {
        value: picked,
        confidence: existing?.value ? existing.confidence : 0.7,
        source: existing?.value ? existing.source : 'inference',
      };
    }
    const [updated] = await db.update(receipts)
      .set({
        ocrStatus: 'done',
        ocrText: result.text,
        ocrData: result,
        ocrRequestId: result.requestId || null,
        ocrProvider: result.provider || null,
        ocrConfidence: result.ocrConfidence != null ? String(result.ocrConfidence) : null,
        ocrOverallConfidence: result.overallConfidence != null ? String(result.overallConfidence) : null,
        ocrNeedsReview: result.needsReview,
        ocrReviewReasons: result.reviewReasons ?? null,
        ocrCostEstimateUsd: result.costEstimateUsd != null ? String(result.costEstimateUsd) : null,
        ocrErrorSummary: null,
        ocrCompletedAt: new Date(),
      })
      .where(eq(receipts.id, receiptId))
      .returning();
    return updated;
  } catch (err) {
    const summary = err instanceof OcrAuthError
      ? 'OCR auth error — check OCR_SERVICE_INTERNAL_TOKEN config'
      : err instanceof Error
        ? err.message.slice(0, 500)
        : 'OCR processing failed';
    const [updated] = await db.update(receipts)
      .set({ ocrStatus: 'failed', ocrErrorSummary: summary, ocrCompletedAt: new Date() })
      .where(eq(receipts.id, receiptId))
      .returning();
    return updated;
  }
}
