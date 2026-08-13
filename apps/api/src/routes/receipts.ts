import path from 'path';
import fs from 'fs/promises';
import { Router } from 'express';
import multer from 'multer';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index';
import { receipts, expenses } from '../db/schema';
import { authenticate } from '../middleware/auth';
import { asyncHandler, notFound, forbidden, createError } from '../middleware/error';
import { storage } from '../lib/storage';
import { runReceiptOcr } from '../lib/runReceiptOcr';
import { maybeAutoPushPending } from '../lib/pendingCompletionDb';
import { toJpegIfHeic } from '../lib/receiptImage';
import { auditLog } from '../lib/audit';
import { env } from '../config/env';
import { roleAllowed } from '../lib/roles';

const router = Router({ mergeParams: true });
router.use(authenticate);

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'image/heic', 'image/heif']);
const ALLOWED_EXT = new Set(['pdf', 'heic', 'heif']);
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    // Some browsers send application/octet-stream for PDFs/HEIC — allow by extension as a fallback
    const ext = file.originalname.split('.').pop()?.toLowerCase() ?? '';
    if (ALLOWED_MIME.has(file.mimetype) || ALLOWED_EXT.has(ext)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: jpeg, png, webp, heic, heif, pdf`));
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

// Upload receipt — sync-primary: awaits OCR unless ?async=1
router.post('/', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw createError('No file uploaded', 400, 'NO_FILE');

  const expense = await db.query.expenses.findFirst({ where: eq(expenses.id, req.params.expenseId) });
  if (!expense) throw notFound('Expense not found');
  if (expense.userId !== req.user!.id) throw forbidden();

  const runAsync = req.query.async === '1' || req.query.async === 'true';

  // iPhone HEIC/HEIF photos become JPEG so OCR and browsers can read them.
  const file = await toJpegIfHeic(req.file.buffer, req.file.mimetype, req.file.originalname);

  const stored = await storage.save(file.buffer, file.filename, file.mimeType);

  const [receipt] = await db.insert(receipts).values({
    expenseId: req.params.expenseId,
    filename: file.filename,
    mimeType: file.mimeType,
    sizeBytes: file.buffer.length,
    storagePath: stored.storagePath,
    ocrStatus: 'pending',
  }).returning();

  await auditLog({ entityType: 'receipt', entityId: receipt.id, userId: req.user!.id, action: 'uploaded', after: { expenseId: receipt.expenseId } });

  if (runAsync) {
    // Escape hatch only — see docs/SYNC_AND_OFFLINE.md
    void runReceiptOcr(receipt.id, stored.storagePath).then(() =>
      maybeAutoPushPending(req.params.expenseId, req.user!.id),
    );
    res.status(201).json({ receipt, ocrMode: 'async' });
    return;
  }

  const withOcr = await runReceiptOcr(receipt.id, stored.storagePath);
  // A receipt was often the last missing piece of a pending daily expense —
  // completing it auto-approves and pushes without accountant review.
  const completion = await maybeAutoPushPending(req.params.expenseId, req.user!.id);
  res.status(201).json({ receipt: withOcr, ocrMode: 'sync', autoPushed: completion?.autoPushed });
}));

// Stream receipt file inline (session cookie auth — used by UI preview)
router.get('/:receiptId/content', asyncHandler(async (req, res) => {
  const expense = await db.query.expenses.findFirst({ where: eq(expenses.id, req.params.expenseId) });
  if (!expense) throw notFound('Expense not found');
  const isOwner = expense.userId === req.user!.id;
  const isPrivileged = roleAllowed(req.user!.role, ['accountant', 'admin']);
  if (!isOwner && !isPrivileged) throw forbidden();

  const receipt = await db.query.receipts.findFirst({
    where: and(eq(receipts.id, req.params.receiptId), eq(receipts.expenseId, req.params.expenseId)),
  });
  if (!receipt) throw notFound('Receipt not found');

  const fullPath = path.join(env.UPLOADS_DIR, receipt.storagePath);
  const data = await fs.readFile(fullPath);
  res.setHeader('Content-Type', receipt.mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${receipt.filename.replace(/"/g, '')}"`);
  res.send(data);
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
