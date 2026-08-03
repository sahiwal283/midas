// Browser extension expense submission endpoint.
// Auth: session cookie (same as all user-facing routes).
//
// Rules enforced here:
//   - Created expense has status='pending' — always enters accountant review queue
//   - Never calls Zoho
//   - Never auto-approves
//   - Writes three audit log entries: expense created, receipt attached, capture linked
//   - Does not set zohoEntity or zohoExpenseId
//   - Audit metadata never contains base64 image data
import { Router } from 'express';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index';
import { expenses, receipts, captures, expenseCategories } from '../db/schema';
import { authenticate } from '../middleware/auth';
import { asyncHandler, createError } from '../middleware/error';
import { storage } from '../lib/storage';
import { runReceiptOcr } from '../lib/runReceiptOcr';
import { auditLog } from '../lib/audit';
import { env } from '../config/env';

const router = Router();
router.use(authenticate);

const ALLOWED_EXT_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const MAX_EXT_SIZE = 10 * 1024 * 1024; // 10 MB

// ── GET /categories — active categories, safe for extension consumption ────────

router.get('/categories', asyncHandler(async (_req, res) => {
  const rows = await db.query.expenseCategories.findMany({
    where: eq(expenseCategories.isActive, true),
    columns: { id: true, name: true, description: true },
    orderBy: (t, { asc }) => [asc(t.name)],
  });
  res.json({ categories: rows });
}));

// ── POST /expenses — atomic expense + receipt + capture creation ───────────────

const submitSchema = z.object({
  imageDataUrl: z.string().min(50, 'imageDataUrl is required'),
  merchant: z.string().min(1, 'merchant is required'),
  amount: z.coerce.number().positive('amount must be positive'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  currency: z.string().length(3).default('USD'),
  categoryId: z.string().uuid().optional(),
  description: z.string().max(2000).optional(),
  reimbursementRequired: z.boolean().default(false),
  pageUrl: z.string().url().optional().or(z.literal('')),
  pageTitle: z.string().max(500).optional(),
  selectedText: z.string().max(5000).optional(),
});

router.post('/expenses', asyncHandler(async (req, res) => {
  const body = submitSchema.parse(req.body);

  // Validate categoryId if provided — reject stale/inactive IDs early
  if (body.categoryId) {
    const cat = await db.query.expenseCategories.findFirst({
      where: and(eq(expenseCategories.id, body.categoryId), eq(expenseCategories.isActive, true)),
      columns: { id: true },
    });
    if (!cat) throw createError('Category not found or inactive', 400, 'INVALID_CATEGORY');
  }

  // 1. Decode image
  const match = body.imageDataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) throw createError('Invalid imageDataUrl format', 400, 'INVALID_IMAGE');
  const [, mimeType, base64Data] = match;

  if (!ALLOWED_EXT_MIME.has(mimeType)) {
    throw createError(`Unsupported file type: ${mimeType}. Allowed: jpeg, png, webp, pdf`, 415, 'UNSUPPORTED_MIME');
  }

  const buffer = Buffer.from(base64Data, 'base64');
  if (buffer.length > MAX_EXT_SIZE) {
    throw createError(`Image exceeds 10 MB limit (received ${(buffer.length / 1024 / 1024).toFixed(1)} MB)`, 413, 'FILE_TOO_LARGE');
  }

  // 2. Persist image to storage
  const stored = await storage.save(buffer, `ext-capture-${Date.now()}.png`, mimeType);

  // 3. Create expense — status is 'pending' so it enters accountant queue immediately
  const [expense] = await db.insert(expenses).values({
    userId: req.user!.id,
    merchant: body.merchant,
    amount: String(body.amount),
    currency: body.currency,
    date: body.date,
    categoryId: body.categoryId ?? null,
    description: body.description ?? null,
    sourceApp: 'browser_extension',
    sourceRefId: body.pageUrl || null,
    sourceType: body.pageUrl ? 'online_receipt' : 'manual',
    status: 'pending',
    reimbursementStatus: body.reimbursementRequired ? 'pending' : 'not_requested',
  }).returning();

  // 4. Create receipt linked to the expense
  const [receipt] = await db.insert(receipts).values({
    expenseId: expense.id,
    filename: `extension-capture-${expense.id}.png`,
    mimeType,
    sizeBytes: buffer.length,
    storagePath: stored.storagePath,
    ocrStatus: 'pending',
  }).returning();

  // 5. Create a capture row linked to the expense (status='linked' immediately)
  const [capture] = await db.insert(captures).values({
    userId: req.user!.id,
    expenseId: expense.id,
    source: 'extension',
    pageUrl: body.pageUrl || null,
    pageTitle: body.pageTitle ?? null,
    selectedText: body.selectedText ?? null,
    imagePath: stored.storagePath,
    status: 'linked',
  }).returning();

  // 6. Three audit entries — one per entity created.
  //    Metadata never contains base64 data — only stable identifiers and flags.
  await auditLog({
    entityType: 'expense',
    entityId: expense.id,
    userId: req.user!.id,
    action: 'expense_created_from_extension',
    after: { status: 'pending', sourceApp: 'browser_extension', sourceType: expense.sourceType },
    metadata: {
      pageUrl: body.pageUrl,
      pageTitle: body.pageTitle,
      hasSelectedText: Boolean(body.selectedText),
      captureId: capture.id,
      receiptId: receipt.id,
    },
  });

  await auditLog({
    entityType: 'receipt',
    entityId: receipt.id,
    userId: req.user!.id,
    action: 'receipt_attached_from_extension',
    after: { expenseId: expense.id, sizeBytes: receipt.sizeBytes, mimeType },
    metadata: { expenseId: expense.id },
  });

  await auditLog({
    entityType: 'capture',
    entityId: capture.id,
    userId: req.user!.id,
    action: 'capture_linked_to_expense',
    after: { expenseId: expense.id, status: 'linked' },
    metadata: { expenseId: expense.id, hasSelectedText: Boolean(body.selectedText) },
  });

  // 7. Sync-primary OCR — response includes completed OCR state (see docs/SYNC_AND_OFFLINE.md)
  const receiptWithOcr = await runReceiptOcr(receipt.id, stored.storagePath);

  // 8. Build the web URL — extension uses this for the "Open in Midas" button
  const midasWebUrl = `${env.CORS_ORIGIN}/expenses/${expense.id}`;

  res.status(201).json({ expense, receipt: receiptWithOcr, capture, midasUrl: midasWebUrl, ocrMode: 'sync' });
}));

export default router;
