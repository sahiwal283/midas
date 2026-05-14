import { Router } from 'express';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import { db } from '../db/index';
import { captures } from '../db/schema';
import { authenticate } from '../middleware/auth';
import { asyncHandler, notFound, forbidden, createError } from '../middleware/error';
import { storage } from '../lib/storage';
import { auditLog } from '../lib/audit';

const router = Router();
router.use(authenticate);

const ALLOWED_CAPTURE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const MAX_CAPTURE_SIZE = 10 * 1024 * 1024; // 10 MB

const linkSchema = z.object({
  expenseId: z.string().uuid().optional(),
  status: z.enum(['linked', 'discarded']),
});

// List own captures
router.get('/', asyncHandler(async (req, res) => {
  const rows = await db.query.captures.findMany({
    where: eq(captures.userId, req.user!.id),
    orderBy: [desc(captures.createdAt)],
  });
  res.json({ captures: rows });
}));

// Submit a capture (from browser extension or manual)
// Accepts a data URL (base64) in the body for extension submissions
router.post('/', asyncHandler(async (req, res) => {
  const { imageDataUrl, pageUrl, pageTitle, selectedText } = z.object({
    imageDataUrl: z.string().min(10),
    pageUrl: z.string().url().optional().or(z.literal('')),
    pageTitle: z.string().optional(),
    selectedText: z.string().max(5000).optional(),
  }).parse(req.body);

  // Convert data URL to buffer
  const match = imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw createError('Invalid image data URL', 400, 'INVALID_IMAGE');
  const [, mimeType, base64Data] = match;

  if (!ALLOWED_CAPTURE_MIME.has(mimeType)) {
    throw createError(`Unsupported file type: ${mimeType}. Allowed: jpeg, png, webp, pdf`, 415, 'UNSUPPORTED_MIME');
  }

  const buffer = Buffer.from(base64Data, 'base64');
  if (buffer.length > MAX_CAPTURE_SIZE) {
    throw createError(`Image exceeds 10 MB limit (received ${(buffer.length / 1024 / 1024).toFixed(1)} MB)`, 413, 'FILE_TOO_LARGE');
  }

  const stored = await storage.save(buffer, `capture-${Date.now()}.png`, mimeType);

  const [capture] = await db.insert(captures).values({
    userId: req.user!.id,
    source: 'extension',
    pageUrl: pageUrl || null,
    pageTitle: pageTitle ?? null,
    selectedText: selectedText ?? null,
    imagePath: stored.storagePath,
    status: 'draft',
  }).returning();

  await auditLog({ entityType: 'capture', entityId: capture.id, userId: req.user!.id, action: 'created' });

  res.status(201).json({ capture });
}));

// Link or discard a capture
router.patch('/:id', asyncHandler(async (req, res) => {
  const capture = await db.query.captures.findFirst({ where: eq(captures.id, req.params.id) });
  if (!capture) throw notFound('Capture not found');
  if (capture.userId !== req.user!.id) throw forbidden();

  const { expenseId, status } = linkSchema.parse(req.body);

  const [updated] = await db.update(captures)
    .set({ status, expenseId: expenseId ?? null })
    .where(eq(captures.id, req.params.id))
    .returning();

  res.json({ capture: updated });
}));

export default router;
