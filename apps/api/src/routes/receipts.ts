import path from 'path';
import fs from 'fs/promises';
import { Router } from 'express';
import multer from 'multer';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index';
import { receipts, expenses, transactions } from '../db/schema';
import { authenticate } from '../middleware/auth';
import { asyncHandler, notFound, forbidden, createError } from '../middleware/error';
import { storage } from '../lib/storage';
import { runReceiptOcr } from '../lib/runReceiptOcr';
import { maybeAutoPushPending } from '../lib/pendingCompletionDb';
import { toJpegIfHeic } from '../lib/receiptImage';
import { auditLog } from '../lib/audit';
import { env } from '../config/env';
import { roleAllowed } from '../lib/roles';
import { resolveReceiptOwner, receiptOwnerValues, type ReceiptOwnerRef } from '../lib/receiptOwner';
import type { UserRole } from '@midas/shared';

const router = Router({ mergeParams: true });
router.use(authenticate);

/**
 * Load the owning record and authorize the caller against it.
 *
 * Ownership rules are unchanged per owner: an expense's own submitter, or an
 * accountant/admin. Purchase orders follow the transaction's `userId` the same
 * way. Returning the row lets callers reuse it without a second query.
 */
async function loadOwnerFor(
  owner: ReceiptOwnerRef,
  user: { id: string; role: UserRole },
  { requireSubmitter }: { requireSubmitter: boolean },
) {
  if (owner.kind === 'expense') {
    const expense = await db.query.expenses.findFirst({ where: eq(expenses.id, owner.id) });
    if (!expense) throw notFound('Expense not found');
    const isOwner = expense.userId === user.id;
    if (requireSubmitter ? !isOwner : !(isOwner || roleAllowed(user.role, ['accountant', 'admin']))) {
      throw forbidden();
    }
    return { kind: 'expense' as const, userId: expense.userId };
  }

  const tx = await db.query.transactions.findFirst({ where: eq(transactions.id, owner.id) });
  if (!tx) throw notFound('Transaction not found');
  const isOwner = tx.userId === user.id;
  if (requireSubmitter ? !isOwner : !(isOwner || roleAllowed(user.role, ['accountant', 'admin']))) {
    throw forbidden();
  }
  return { kind: 'transaction' as const, userId: tx.userId };
}

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

// List receipts for an expense or purchase-order transaction
router.get('/', asyncHandler(async (req, res) => {
  const owner = resolveReceiptOwner(req.params);
  await loadOwnerFor(owner, req.user!, { requireSubmitter: false });

  const ownerFilter = owner.kind === 'expense'
    ? eq(receipts.expenseId, owner.id)
    : eq(receipts.transactionId, owner.id);

  const rows = await db.query.receipts.findMany({ where: ownerFilter });
  res.json({ receipts: rows });
}));

// Upload receipt — sync-primary: awaits OCR unless ?async=1
router.post('/', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw createError('No file uploaded', 400, 'NO_FILE');

  const owner = resolveReceiptOwner(req.params);
  await loadOwnerFor(owner, req.user!, { requireSubmitter: true });

  const runAsync = req.query.async === '1' || req.query.async === 'true';

  // iPhone HEIC/HEIF photos become JPEG so OCR and browsers can read them.
  const file = await toJpegIfHeic(req.file.buffer, req.file.mimetype, req.file.originalname);
  const stored = await storage.save(file.buffer, file.filename, file.mimeType);

  const [receipt] = await db.insert(receipts).values({
    ...receiptOwnerValues(owner),
    filename: file.filename,
    mimeType: file.mimeType,
    sizeBytes: file.buffer.length,
    storagePath: stored.storagePath,
    ocrStatus: 'pending',
  }).returning();

  await auditLog({
    entityType: 'receipt',
    entityId: receipt.id,
    userId: req.user!.id,
    action: 'uploaded',
    after: { expenseId: receipt.expenseId, transactionId: receipt.transactionId },
  });

  // A receipt was often the last missing piece of a pending daily expense —
  // completing it auto-approves and pushes without accountant review. That
  // rule is expense-only; a purchase order always goes through its own review.
  const autoPush = owner.kind === 'expense'
    ? () => maybeAutoPushPending(owner.id, req.user!.id)
    : async () => undefined;

  if (runAsync) {
    // Escape hatch only — see docs/SYNC_AND_OFFLINE.md
    void runReceiptOcr(receipt.id, stored.storagePath).then(autoPush);
    res.status(201).json({ receipt, ocrMode: 'async' });
    return;
  }

  const withOcr = await runReceiptOcr(receipt.id, stored.storagePath);
  const completion = await autoPush();
  res.status(201).json({ receipt: withOcr, ocrMode: 'sync', autoPushed: completion?.autoPushed });
}));

// Stream receipt file inline (session cookie auth — used by UI preview)
router.get('/:receiptId/content', asyncHandler(async (req, res) => {
  const owner = resolveReceiptOwner(req.params);
  await loadOwnerFor(owner, req.user!, { requireSubmitter: false });

  const ownerFilter = owner.kind === 'expense'
    ? eq(receipts.expenseId, owner.id)
    : eq(receipts.transactionId, owner.id);

  const receipt = await db.query.receipts.findFirst({
    where: and(eq(receipts.id, req.params.receiptId), ownerFilter),
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
  const owner = resolveReceiptOwner(req.params);
  await loadOwnerFor(owner, req.user!, { requireSubmitter: false });

  const ownerFilter = owner.kind === 'expense'
    ? eq(receipts.expenseId, owner.id)
    : eq(receipts.transactionId, owner.id);

  const receipt = await db.query.receipts.findFirst({
    where: and(eq(receipts.id, req.params.receiptId), ownerFilter),
  });
  if (!receipt) throw notFound('Receipt not found');

  await storage.delete(receipt.storagePath);
  await db.delete(receipts).where(eq(receipts.id, receipt.id));
  await auditLog({ entityType: 'receipt', entityId: receipt.id, userId: req.user!.id, action: 'deleted' });

  res.json({ ok: true });
}));

export default router;
