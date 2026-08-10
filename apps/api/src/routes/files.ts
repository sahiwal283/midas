import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import { Router, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { receipts, captures } from '../db/schema';
import { authenticate } from '../middleware/auth';
import { asyncHandler, notFound, forbidden } from '../middleware/error';
import { roleAllowed } from '../lib/roles';
import { env } from '../config/env';

/**
 * Authenticated file serving — replaces the public /uploads static mount.
 * Session cookie auth; allowed for the owning user or accountant/admin
 * (developer passes every role gate via roleAllowed).
 */
const router = Router();
router.use(authenticate);

/** Resolve a stored path inside UPLOADS_DIR; null if it escapes (traversal). */
function resolveUploadPath(storagePath: string): string | null {
  const base = path.resolve(env.UPLOADS_DIR);
  const full = path.resolve(base, storagePath);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

async function streamFile(res: Response, storagePath: string, mimeType: string, filename: string): Promise<void> {
  const fullPath = resolveUploadPath(storagePath);
  if (!fullPath) throw notFound('File not found');
  try {
    await fsp.access(fullPath);
  } catch {
    throw notFound('File not found');
  }
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${filename.replace(/"/g, '')}"`);
  fs.createReadStream(fullPath).pipe(res);
}

// ── Receipts ──────────────────────────────────────────────────────────────────

router.get('/receipts/:receiptId', asyncHandler(async (req, res) => {
  const receipt = await db.query.receipts.findFirst({
    where: eq(receipts.id, req.params.receiptId),
    with: { expense: { columns: { userId: true } } },
  });
  if (!receipt) throw notFound('Receipt not found');

  const isOwner = receipt.expense.userId === req.user!.id;
  if (!isOwner && !roleAllowed(req.user!.role, ['accountant', 'admin'])) throw forbidden();

  await streamFile(res, receipt.storagePath, receipt.mimeType, receipt.filename);
}));

// ── Captures ──────────────────────────────────────────────────────────────────

/** Captures store no mimeType column — infer from the stored file extension. */
function captureMimeType(imagePath: string): string {
  const ext = imagePath.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'pdf': return 'application/pdf';
    default: return 'image/png';
  }
}

router.get('/captures/:captureId', asyncHandler(async (req, res) => {
  const capture = await db.query.captures.findFirst({ where: eq(captures.id, req.params.captureId) });
  if (!capture) throw notFound('Capture not found');

  const isOwner = capture.userId === req.user!.id;
  if (!isOwner && !roleAllowed(req.user!.role, ['accountant', 'admin'])) throw forbidden();

  await streamFile(res, capture.imagePath, captureMimeType(capture.imagePath), path.basename(capture.imagePath));
}));

export default router;
