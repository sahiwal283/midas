import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { receipts, expenses } from '../db/schema';
import { authenticate } from '../middleware/auth';
import { asyncHandler, notFound, forbidden, createError } from '../middleware/error';
import { storage } from '../lib/storage';
import { ocr, OcrAuthError } from '../lib/ocr';
import { auditLog } from '../lib/audit';
import { env } from '../config/env';

const router = Router({ mergeParams: true });
router.use(authenticate);

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    // Some browsers send application/octet-stream for PDFs — allow by extension as a fallback
    const ext = file.originalname.split('.').pop()?.toLowerCase();
    if (ALLOWED_MIME.has(file.mimetype) || ext === 'pdf') return cb(null, true);
    cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: jpeg, png, webp, pdf`));
  },
});

// List receipts for an expense
router.get('/', asyncHandler(async (req, res) => {
  const expense = await db.query.expenses.findFirst({ where: eq(expenses.id, req.params.expenseId) });
  if (!expense) throw notFound('Expense not found');
  const isOwner = expense.userId === req.user!.id;
  const isPrivileged = req.user!.role !== 'user';
  if (!isOwner && !isPrivileged) throw forbidden();

  const rows = await db.query.receipts.findMany({ where: eq(receipts.expenseId, req.params.expenseId) });
  res.json({ receipts: rows });
}));

// Upload receipt
router.post('/', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw createError('No file uploaded', 400, 'NO_FILE');

  const expense = await db.query.expenses.findFirst({ where: eq(expenses.id, req.params.expenseId) });
  if (!expense) throw notFound('Expense not found');
  if (expense.userId !== req.user!.id) throw forbidden();

  const stored = await storage.save(req.file.buffer, req.file.originalname, req.file.mimetype);

  const [receipt] = await db.insert(receipts).values({
    expenseId: req.params.expenseId,
    filename: req.file.originalname,
    mimeType: req.file.mimetype,
    sizeBytes: req.file.size,
    storagePath: stored.storagePath,
    ocrStatus: 'pending',
  }).returning();

  await auditLog({ entityType: 'receipt', entityId: receipt.id, userId: req.user!.id, action: 'uploaded', after: { expenseId: receipt.expenseId } });

  // Kick off OCR in the background — don't block the response
  void (async () => {
    const submittedAt = new Date();
    await db.update(receipts)
      .set({ ocrStatus: 'processing', ocrSubmittedAt: submittedAt })
      .where(eq(receipts.id, receipt.id));
    try {
      const fullPath = path.join(env.UPLOADS_DIR, stored.storagePath);
      const result = await ocr.process(fullPath, receipt.id);
      await db.update(receipts)
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
        .where(eq(receipts.id, receipt.id));
    } catch (err) {
      const summary = err instanceof OcrAuthError
        ? 'OCR auth error — check OCR_SERVICE_INTERNAL_TOKEN config'
        : err instanceof Error
          ? err.message.slice(0, 500)
          : 'OCR processing failed';
      await db.update(receipts)
        .set({ ocrStatus: 'failed', ocrErrorSummary: summary, ocrCompletedAt: new Date() })
        .where(eq(receipts.id, receipt.id));
    }
  })();

  res.status(201).json({ receipt });
}));

// Delete a receipt
router.delete('/:receiptId', asyncHandler(async (req, res) => {
  const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, req.params.receiptId) });
  if (!receipt) throw notFound('Receipt not found');

  const expense = await db.query.expenses.findFirst({ where: eq(expenses.id, receipt.expenseId) });
  if (!expense || expense.userId !== req.user!.id) throw forbidden();

  await storage.delete(receipt.storagePath);
  await db.delete(receipts).where(eq(receipts.id, receipt.id));
  await auditLog({ entityType: 'receipt', entityId: receipt.id, userId: req.user!.id, action: 'deleted' });

  res.json({ ok: true });
}));

export default router;
