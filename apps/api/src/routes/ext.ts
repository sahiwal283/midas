/**
 * External app-to-app API (`/api/v1/ext/*`).
 * Spec: docs/EXT_API_MERGE_LOCK.md
 */
import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  and, asc, eq, gt, gte, ilike, lte, or, sql,
} from 'drizzle-orm';
import { ImportService, type ImportRecord } from '@midas/import';
import { db } from '../db/index';
import {
  expenseCategories,
  expenses,
  receipts,
  users,
  type ExpenseSourceContext,
} from '../db/schema';
import { authenticateApiKey } from '../middleware/auth';
import { requireScope } from '../middleware/requireScope';
import { asyncHandler, createError, notFound } from '../middleware/error';
import { auditLog } from '../lib/audit';
import { resolveCategoryId, resolveCategoryIdOrOther } from '../lib/ext/categories';
import { EXT_EXPENSE_WITH, toExtExpenseDto } from '../lib/ext/dto';
import { ExtImportTargetPort } from '../lib/ext/importTarget';
import { mapImportExpenseStatus, mapImportReimbursementStatus } from '../lib/ext/maps';
import { resolveExtUser } from '../lib/ext/users';
import { ocr } from '../lib/ocr';
import { runReceiptOcr } from '../lib/runReceiptOcr';
import { storage } from '../lib/storage';
import { env } from '../config/env';

const router = Router();
router.use(authenticateApiKey);

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
  'image/heic', 'image/heif',
]);
const MAX_SIZE = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.split('.').pop()?.toLowerCase();
    if (ALLOWED_MIME.has(file.mimetype) || ext === 'pdf' || ext === 'heic' || ext === 'heif') {
      return cb(null, true);
    }
    cb(new Error(`Unsupported file type: ${file.mimetype}`));
  },
});

const expenseStatusEnum = z.enum([
  'draft', 'pending', 'in_review', 'awaiting_info', 'approved', 'zoho_sync_failed', 'rejected',
]);

function actorEmail(req: { body?: { submitterEmail?: string }; headers: Record<string, unknown> }): string | undefined {
  const header = req.headers['x-actor-email'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (typeof req.body?.submitterEmail === 'string') return req.body.submitterEmail.trim();
  return undefined;
}

function actorExternalUserId(req: { body?: { externalUserId?: string }; headers: Record<string, unknown> }): string | null {
  const header = req.headers['x-actor-external-user-id'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (typeof req.body?.externalUserId === 'string') return req.body.externalUserId.trim();
  return null;
}

function actorName(req: { headers: Record<string, unknown> }): string | null {
  const header = req.headers['x-actor-name'];
  return typeof header === 'string' && header.trim() ? header.trim() : null;
}

async function loadExpenseDto(id: string) {
  const row = await db.query.expenses.findFirst({
    where: eq(expenses.id, id),
    with: EXT_EXPENSE_WITH,
  });
  if (!row) return null;
  return toExtExpenseDto(row);
}

// ── Categories ───────────────────────────────────────────────────────────────

router.get('/categories', requireScope('expenses:read'), asyncHandler(async (_req, res) => {
  const rows = await db.query.expenseCategories.findMany({
    where: eq(expenseCategories.isActive, true),
    orderBy: [asc(expenseCategories.name)],
  });
  res.json({
    categories: rows.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      isActive: c.isActive,
    })),
  });
}));

// ── Standalone OCR ───────────────────────────────────────────────────────────

router.post('/ocr/process', requireScope('ocr:process'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw createError('No file uploaded', 400, 'NO_FILE');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'midas-ext-ocr-'));
  const tmpPath = path.join(tmpDir, req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_'));
  try {
    await fs.writeFile(tmpPath, req.file.buffer);
    const result = await ocr.process(tmpPath, `ext-ocr-${Date.now()}`);
    const amountRaw = result.fields.amount?.value;
    const amountNum = amountRaw != null && amountRaw !== '' ? Number(amountRaw) : null;

    res.json({
      ocrMode: 'sync',
      fields: {
        merchant: { value: result.fields.merchant?.value ?? null, confidence: result.fields.merchant?.confidence ?? 0 },
        amount: {
          value: Number.isFinite(amountNum as number) ? amountNum : null,
          confidence: result.fields.amount?.confidence ?? 0,
        },
        date: { value: result.fields.date?.value ?? null, confidence: result.fields.date?.confidence ?? 0 },
        category: { value: result.fields.category?.value ?? null, confidence: result.fields.category?.confidence ?? 0 },
        location: {
          value: result.fields.location?.value ?? null,
          confidence: result.fields.location?.confidence ?? 0,
        },
        cardLastFour: {
          value: result.fields.cardLastFour?.value ?? null,
          confidence: result.fields.cardLastFour?.confidence ?? 0,
        },
      },
      ocr: {
        text: result.text,
        confidence: result.ocrConfidence,
        provider: result.provider,
      },
      quality: {
        overallConfidence: result.overallConfidence,
        needsReview: result.needsReview,
        reviewReasons: result.reviewReasons ?? [],
      },
      warnings: [],
    });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}));

// ── List expenses ────────────────────────────────────────────────────────────

router.get('/expenses', requireScope('expenses:read'), asyncHandler(async (req, res) => {
  const sourceApp = typeof req.query.sourceApp === 'string' ? req.query.sourceApp : undefined;
  if (!sourceApp) throw createError('sourceApp query param is required', 400, 'VALIDATION_ERROR');

  const conditions = [eq(expenses.sourceApp, sourceApp)];

  const eventId = typeof req.query.eventId === 'string' ? req.query.eventId : undefined;
  if (eventId) {
    conditions.push(sql`${expenses.sourceContext}->>'eventId' = ${eventId}`);
  }

  const eventIdsRaw = typeof req.query.eventIds === 'string' ? req.query.eventIds : undefined;
  if (eventIdsRaw) {
    const ids = eventIdsRaw.split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length) {
      conditions.push(
        or(...ids.map((id) => sql`${expenses.sourceContext}->>'eventId' = ${id}`))!,
      );
    }
  }

  const externalUserId = typeof req.query.externalUserId === 'string' ? req.query.externalUserId : undefined;
  if (externalUserId) conditions.push(eq(expenses.externalUserId, externalUserId));

  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  if (status) {
    const parsed = expenseStatusEnum.safeParse(status);
    if (!parsed.success) throw createError('Invalid status', 400, 'VALIDATION_ERROR');
    conditions.push(eq(expenses.status, parsed.data));
  }

  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q) {
    conditions.push(or(ilike(expenses.merchant, `%${q}%`), ilike(expenses.description, `%${q}%`))!);
  }

  const dateFrom = typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined;
  const dateTo = typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined;
  if (dateFrom) conditions.push(gte(expenses.date, dateFrom));
  if (dateTo) conditions.push(lte(expenses.date, dateTo));

  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { c: string; i: string };
      conditions.push(
        or(
          gt(expenses.createdAt, new Date(decoded.c)),
          and(eq(expenses.createdAt, new Date(decoded.c)), gt(expenses.id, decoded.i)),
        )!,
      );
    } catch {
      throw createError('Invalid cursor', 400, 'VALIDATION_ERROR');
    }
  }

  const rows = await db.query.expenses.findMany({
    where: and(...conditions),
    with: EXT_EXPENSE_WITH,
    orderBy: [asc(expenses.createdAt), asc(expenses.id)],
    limit: limit + 1,
  });

  const page = rows.slice(0, limit);
  const next = rows.length > limit ? rows[limit - 1] : null;
  const nextCursor = next
    ? Buffer.from(JSON.stringify({ c: next.createdAt.toISOString(), i: next.id }), 'utf8').toString('base64url')
    : null;

  res.json({
    expenses: page.map((r) => toExtExpenseDto(r)),
    nextCursor,
  });
}));

// ── By-ref (before :id) ──────────────────────────────────────────────────────

router.get('/expenses/by-ref', requireScope('expenses:read'), asyncHandler(async (req, res) => {
  const sourceApp = typeof req.query.sourceApp === 'string' ? req.query.sourceApp : undefined;
  const sourceRefId = typeof req.query.sourceRefId === 'string' ? req.query.sourceRefId : undefined;
  if (!sourceApp || !sourceRefId) {
    throw createError('sourceApp and sourceRefId are required', 400, 'VALIDATION_ERROR');
  }
  const row = await db.query.expenses.findFirst({
    where: and(eq(expenses.sourceApp, sourceApp), eq(expenses.sourceRefId, sourceRefId)),
    with: EXT_EXPENSE_WITH,
  });
  if (!row) throw notFound('Expense not found');
  const expense = toExtExpenseDto(row);
  res.json({ expense, midasUrl: expense.midasUrl });
}));

// ── Create ───────────────────────────────────────────────────────────────────

const createSchema = z.object({
  sourceApp: z.string().min(1),
  sourceRefId: z.string().min(1),
  submitterEmail: z.string().email().optional(),
  externalUserId: z.string().min(1).optional(),
  eventId: z.string().min(1).optional(),
  sourceLabel: z.string().min(1).optional(),
  sourceUrl: z.union([z.string().url(), z.literal(''), z.null()]).optional(),
  sourceType: z.string().min(1).optional(),
  merchant: z.string().min(1),
  amount: z.coerce.number().positive(),
  currency: z.string().length(3).default('USD'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().optional().nullable(),
  categoryId: z.string().uuid().optional().nullable(),
  categoryName: z.string().optional().nullable(),
  paymentMethodId: z.string().uuid().optional().nullable(),
  cardUsed: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  reimbursementRequired: z.boolean().optional(),
  status: expenseStatusEnum.optional(),
  zohoEntity: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional(),
});

router.post('/expenses', requireScope('expenses:create'), asyncHandler(async (req, res) => {
  const body = createSchema.parse(req.body);

  if (body.sourceApp === 'trade_show') {
    if (!body.eventId) throw createError('eventId is required when sourceApp=trade_show', 400, 'VALIDATION_ERROR');
    if (!body.sourceLabel) throw createError('sourceLabel is required when sourceApp=trade_show', 400, 'VALIDATION_ERROR');
    if (!body.sourceType) throw createError('sourceType is required when sourceApp=trade_show', 400, 'VALIDATION_ERROR');
  }

  const existing = await db.query.expenses.findFirst({
    where: and(eq(expenses.sourceApp, body.sourceApp), eq(expenses.sourceRefId, body.sourceRefId)),
    with: EXT_EXPENSE_WITH,
  });
  if (existing) {
    const expense = toExtExpenseDto(existing);
    res.status(200).json({ expense, midasUrl: expense.midasUrl, created: false });
    return;
  }

  const email = actorEmail(req) ?? body.submitterEmail;
  if (!email) throw createError('submitterEmail or X-Actor-Email is required', 400, 'VALIDATION_ERROR');

  const user = await resolveExtUser({ email, displayName: actorName(req) });
  const externalUserId = actorExternalUserId(req);

  const resolvedCat = await resolveCategoryId({
    sourceApp: body.sourceApp,
    categoryId: body.categoryId,
    categoryName: body.categoryName,
  });
  const categoryId = resolvedCat.categoryId;

  const sourceContext: ExpenseSourceContext = {
    ...(body.metadata ?? {}),
    ...(body.eventId ? { eventId: body.eventId } : {}),
    ...(body.sourceLabel ? { eventName: body.sourceLabel } : {}),
    location: body.location ?? null,
    cardUsed: body.cardUsed ?? null,
    ...(externalUserId ? { externalUserId } : {}),
  };

  const reimbursementStatus = mapImportReimbursementStatus(undefined, body.reimbursementRequired);

  const [inserted] = await db.insert(expenses).values({
    userId: user.id,
    merchant: body.merchant,
    amount: String(body.amount),
    currency: body.currency,
    date: body.date,
    categoryId,
    paymentMethodId: body.paymentMethodId ?? null,
    description: body.description ?? null,
    sourceApp: body.sourceApp,
    sourceRefId: body.sourceRefId,
    sourceLabel: body.sourceLabel ?? null,
    sourceUrl: body.sourceUrl || null,
    sourceType: body.sourceType ?? null,
    sourceContext,
    externalUserId,
    status: body.status ?? 'pending',
    reimbursementStatus,
    zohoEntity: body.zohoEntity ?? null,
  }).returning();

  await auditLog({
    entityType: 'expense',
    entityId: inserted.id,
    action: 'ext.created',
    metadata: {
      sourceApp: body.sourceApp,
      sourceRefId: body.sourceRefId,
      appConnectionId: req.appConnection?.id,
      provisionedUser: user.provisioned,
    },
    after: inserted,
  });

  const expense = await loadExpenseDto(inserted.id);
  res.status(201).json({ expense, midasUrl: expense!.midasUrl, created: true });
}));

// ── Get / Patch / Delete by id ───────────────────────────────────────────────

router.get('/expenses/:id', requireScope('expenses:read'), asyncHandler(async (req, res) => {
  const expense = await loadExpenseDto(req.params.id);
  if (!expense) throw notFound('Expense not found');
  res.json({ expense, midasUrl: expense.midasUrl });
}));

const patchSchema = z.object({
  merchant: z.string().min(1).optional(),
  amount: z.coerce.number().positive().optional(),
  currency: z.string().length(3).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  description: z.string().nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  categoryName: z.string().nullable().optional(),
  paymentMethodId: z.string().uuid().nullable().optional(),
  cardUsed: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  eventId: z.string().nullable().optional(),
  sourceLabel: z.string().nullable().optional(),
  sourceUrl: z.union([z.string().url(), z.literal(''), z.null()]).optional(),
  reimbursementRequired: z.boolean().optional(),
  status: expenseStatusEnum.optional(),
});

router.patch('/expenses/:id', requireScope('expenses:update'), asyncHandler(async (req, res) => {
  const body = patchSchema.parse(req.body);
  const existing = await db.query.expenses.findFirst({ where: eq(expenses.id, req.params.id) });
  if (!existing) throw notFound('Expense not found');

  const editable = new Set(['draft', 'pending', 'awaiting_info']);
  if (!editable.has(existing.status)) {
    throw createError(`Expense status ${existing.status} is not editable`, 409, 'CONFLICT');
  }

  let categoryId = body.categoryId;
  if (categoryId === undefined && body.categoryName !== undefined) {
    const resolved = await resolveCategoryId({
      sourceApp: existing.sourceApp,
      categoryName: body.categoryName,
    });
    categoryId = resolved.categoryId;
  }

  const ctx: ExpenseSourceContext = { ...(existing.sourceContext ?? {}) };
  if (body.eventId !== undefined) {
    if (body.eventId) ctx.eventId = body.eventId;
    else delete ctx.eventId;
  }
  if (body.location !== undefined) ctx.location = body.location;
  if (body.cardUsed !== undefined) ctx.cardUsed = body.cardUsed;
  if (body.sourceLabel !== undefined && body.sourceLabel) ctx.eventName = body.sourceLabel;

  const [updated] = await db.update(expenses).set({
    ...(body.merchant !== undefined ? { merchant: body.merchant } : {}),
    ...(body.amount !== undefined ? { amount: String(body.amount) } : {}),
    ...(body.currency !== undefined ? { currency: body.currency } : {}),
    ...(body.date !== undefined ? { date: body.date } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(categoryId !== undefined ? { categoryId } : {}),
    ...(body.paymentMethodId !== undefined ? { paymentMethodId: body.paymentMethodId } : {}),
    ...(body.sourceLabel !== undefined ? { sourceLabel: body.sourceLabel } : {}),
    ...(body.sourceUrl !== undefined ? { sourceUrl: body.sourceUrl } : {}),
    ...(body.status !== undefined ? { status: body.status } : {}),
    ...(body.reimbursementRequired !== undefined
      ? { reimbursementStatus: mapImportReimbursementStatus(undefined, body.reimbursementRequired) }
      : {}),
    sourceContext: ctx,
    updatedAt: new Date(),
  }).where(eq(expenses.id, existing.id)).returning();

  await auditLog({
    entityType: 'expense',
    entityId: updated.id,
    action: 'ext.updated',
    before: existing,
    after: updated,
    metadata: { appConnectionId: req.appConnection?.id },
  });

  const expense = await loadExpenseDto(updated.id);
  res.json({ expense, midasUrl: expense!.midasUrl });
}));

router.delete('/expenses/:id', requireScope('expenses:delete'), asyncHandler(async (req, res) => {
  const existing = await db.query.expenses.findFirst({
    where: eq(expenses.id, req.params.id),
    with: { receipts: true },
  });
  if (!existing) throw notFound('Expense not found');

  const canDelete =
    existing.status === 'draft'
    || (existing.status === 'pending' && existing.reviewedAt == null && existing.zohoExpenseId == null);

  if (!canDelete) {
    throw createError('Expense cannot be deleted in its current state', 409, 'CONFLICT');
  }

  for (const r of existing.receipts) {
    await storage.delete(r.storagePath);
  }

  await db.delete(expenses).where(eq(expenses.id, existing.id));

  await auditLog({
    entityType: 'expense',
    entityId: existing.id,
    action: 'ext.deleted',
    before: { id: existing.id, status: existing.status, sourceApp: existing.sourceApp, sourceRefId: existing.sourceRefId },
    metadata: { appConnectionId: req.appConnection?.id },
  });

  res.json({ ok: true });
}));

// ── Receipts ─────────────────────────────────────────────────────────────────

router.post(
  '/expenses/:id/receipts',
  requireScope('receipts:create'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw createError('No file uploaded', 400, 'NO_FILE');
    const expense = await db.query.expenses.findFirst({ where: eq(expenses.id, req.params.id) });
    if (!expense) throw notFound('Expense not found');

    const sha256 = createHash('sha256').update(req.file.buffer).digest('hex');
    const stored = await storage.save(req.file.buffer, req.file.originalname, req.file.mimetype);
    const runAsync = req.query.async === '1' || req.query.async === 'true';

    const [receipt] = await db.insert(receipts).values({
      expenseId: expense.id,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      storagePath: stored.storagePath,
      sha256,
      ocrStatus: 'pending',
    }).returning();

    await auditLog({
      entityType: 'receipt',
      entityId: receipt.id,
      action: 'ext.uploaded',
      after: { expenseId: expense.id },
      metadata: { appConnectionId: req.appConnection?.id },
    });

    if (runAsync) {
      void runReceiptOcr(receipt.id, stored.storagePath);
      res.status(201).json({ receipt, ocrMode: 'async' });
      return;
    }

    const withOcr = await runReceiptOcr(receipt.id, stored.storagePath);
    res.status(201).json({ receipt: withOcr, ocrMode: 'sync' });
  }),
);

router.put(
  '/expenses/:id/receipts/primary',
  requireScope('expenses:update'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw createError('No file uploaded', 400, 'NO_FILE');
    const expense = await db.query.expenses.findFirst({
      where: eq(expenses.id, req.params.id),
      with: { receipts: true },
    });
    if (!expense) throw notFound('Expense not found');

    for (const r of expense.receipts) {
      await storage.delete(r.storagePath);
      await db.delete(receipts).where(eq(receipts.id, r.id));
    }

    const sha256 = createHash('sha256').update(req.file.buffer).digest('hex');
    const stored = await storage.save(req.file.buffer, req.file.originalname, req.file.mimetype);
    const runAsync = req.query.async === '1' || req.query.async === 'true';

    const [receipt] = await db.insert(receipts).values({
      expenseId: expense.id,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      storagePath: stored.storagePath,
      sha256,
      ocrStatus: 'pending',
    }).returning();

    if (runAsync) {
      void runReceiptOcr(receipt.id, stored.storagePath);
      res.json({ receipt, ocrMode: 'async' });
      return;
    }

    const withOcr = await runReceiptOcr(receipt.id, stored.storagePath);
    res.json({ receipt: withOcr, ocrMode: 'sync' });
  }),
);

router.get(
  '/expenses/:id/receipts/:receiptId/content',
  requireScope('expenses:read'),
  asyncHandler(async (req, res) => {
    const receipt = await db.query.receipts.findFirst({
      where: and(eq(receipts.id, req.params.receiptId), eq(receipts.expenseId, req.params.id)),
    });
    if (!receipt) throw notFound('Receipt not found');

    const fullPath = path.join(env.UPLOADS_DIR, receipt.storagePath);
    const data = await fs.readFile(fullPath);
    res.setHeader('Content-Type', receipt.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${receipt.filename.replace(/"/g, '')}"`);
    res.send(data);
  }),
);

// ── Bulk import ──────────────────────────────────────────────────────────────

const importItemSchema = z.object({
  sourceRefId: z.string().min(1),
  submitterEmail: z.string().email(),
  externalUserId: z.string().optional(),
  eventId: z.string().optional(),
  sourceLabel: z.string().optional().nullable(),
  sourceUrl: z.string().optional().nullable(),
  sourceType: z.string().optional().nullable(),
  merchant: z.string().min(1),
  // Allow zero for edge legacy rows; reject negatives
  amount: z.coerce.number().min(0),
  currency: z.string().length(3).default('USD'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().optional().nullable(),
  categoryName: z.string().optional().nullable(),
  cardUsed: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  status: z.string().optional(),
  reimbursementRequired: z.boolean().optional(),
  reimbursementStatus: z.string().optional().nullable(),
  zohoEntity: z.string().optional().nullable(),
  zohoExpenseId: z.string().optional().nullable(),
  ocrText: z.string().optional().nullable(),
  extractedData: z.record(z.unknown()).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  submittedAt: z.string().optional().nullable(),
  reviewedAt: z.string().optional().nullable(),
  comments: z.string().optional().nullable(),
  receipt: z.object({
    filename: z.string(),
    mimeType: z.string(),
    contentBase64: z.string(),
    skipOcr: z.boolean().optional(),
    sha256: z.string().optional(),
  }).optional(),
  auditTrail: z.array(z.object({
    at: z.string(),
    actorEmail: z.string().nullable().optional(),
    actorName: z.string().nullable().optional(),
    action: z.string(),
    changes: z.unknown().optional(),
  })).optional(),
});

const importSchema = z.object({
  sourceApp: z.string().min(1),
  dryRun: z.boolean().default(false),
  items: z.array(importItemSchema).min(1).max(100),
});

router.post('/expenses/import', requireScope('expenses:import'), asyncHandler(async (req, res) => {
  const body = importSchema.parse(req.body);

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'midas-ext-import-'));
  const records: ImportRecord[] = [];
  const warnings: string[] = [];
  /** receipt extractedData to apply after create (not in ImportAttachment yet) */
  const extractedByRef = new Map<string, Record<string, unknown>>();

  try {
    for (const item of body.items) {
      const cat = await resolveCategoryIdOrOther({
        sourceApp: body.sourceApp,
        categoryName: item.categoryName,
      });
      if (cat.warning) warnings.push(`${item.sourceRefId}: ${cat.warning}`);

      let categoryName: string | null = null;
      if (cat.categoryId) {
        const row = await db.query.expenseCategories.findFirst({
          where: eq(expenseCategories.id, cat.categoryId),
        });
        categoryName = row?.name ?? null;
      }

      const attachments: ImportRecord['attachments'] = [];
      if (item.receipt) {
        const buf = Buffer.from(item.receipt.contentBase64, 'base64');
        const filePath = path.join(tmpRoot, `${item.sourceRefId}-${item.receipt.filename}`);
        await fs.writeFile(filePath, buf);
        const sha = item.receipt.sha256 ?? createHash('sha256').update(buf).digest('hex');
        attachments.push({
          filename: item.receipt.filename,
          mimeType: item.receipt.mimeType,
          sizeBytes: buf.length,
          source: { type: 'path', path: filePath },
          sha256: sha,
          ocr: item.receipt.skipOcr || item.ocrText
            ? { status: 'done', text: item.ocrText ?? null }
            : { status: 'pending' },
          createdAt: item.createdAt,
        });
        if (item.extractedData) extractedByRef.set(item.sourceRefId, item.extractedData);
      }

      const sourceContext: ExpenseSourceContext = {
        ...(item.eventId ? { eventId: item.eventId } : {}),
        ...(item.sourceLabel ? { eventName: item.sourceLabel } : {}),
        location: item.location ?? null,
        cardUsed: item.cardUsed ?? null,
        ...(item.externalUserId ? { externalUserId: item.externalUserId } : {}),
        ...(item.submittedAt ? { submittedAt: item.submittedAt } : {}),
      };

      records.push({
        externalId: item.sourceRefId,
        owner: { ownerType: body.sourceApp, ownerId: item.sourceRefId },
        submitterEmail: item.submitterEmail,
        merchant: item.merchant,
        amount: item.amount,
        currency: item.currency,
        date: item.date,
        description: item.description ?? item.comments ?? null,
        categoryName,
        status: mapImportExpenseStatus(item.status),
        reimbursementStatus: mapImportReimbursementStatus(
          item.reimbursementStatus,
          item.reimbursementRequired,
        ),
        reviewedAt: item.reviewedAt ?? null,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        sourceLabel: item.sourceLabel ?? null,
        sourceUrl: item.sourceUrl ?? null,
        sourceType: item.sourceType
          ?? (body.sourceApp === 'trade_show' ? 'trade_show_event' : 'imported'),
        externalUserId: item.externalUserId ?? null,
        sourceContext,
        zohoEntity: item.zohoEntity ?? null,
        zohoExpenseId: item.zohoExpenseId ?? null,
        attachments,
        notes: item.comments
          ? [{ body: item.comments, isSystem: true, createdAt: item.createdAt }]
          : [],
        auditHistory: (item.auditTrail ?? []).map((a) => ({
          action: a.action,
          actorEmail: a.actorEmail,
          after: a.changes,
          createdAt: a.at,
        })),
      });
    }

    // Pre-provision users when enabled so ImportService can resolve emails on apply.
    // dryRun + auto-provision: warn "would_provision" and do not fail the batch for missing users.
    if (env.EXT_AUTO_PROVISION_USERS) {
      for (const r of records) {
        if (body.dryRun) {
          const existing = await db.query.users.findFirst({
            where: eq(users.email, r.submitterEmail.toLowerCase()),
          });
          if (!existing) {
            warnings.push(`${r.externalId}: would auto-provision user ${r.submitterEmail}`);
          }
        } else {
          await resolveExtUser({ email: r.submitterEmail }).catch(() => {});
        }
      }
    }

    const source = {
      name: `ext-import:${body.sourceApp}`,
      async *fetchRecords() {
        for (const r of records) yield r;
      },
    };

    const service = new ImportService(new ExtImportTargetPort({
      dryRun: body.dryRun,
      autoProvision: env.EXT_AUTO_PROVISION_USERS,
    }));
    const report = await service.run(source, { dryRun: body.dryRun });

    if (!body.dryRun && extractedByRef.size > 0) {
      for (const [sourceRefId, extracted] of extractedByRef) {
        const row = await db.query.expenses.findFirst({
          where: and(
            eq(expenses.sourceApp, body.sourceApp),
            eq(expenses.sourceRefId, sourceRefId),
          ),
          with: { receipts: true },
        });
        if (row?.receipts[0]) {
          await db.update(receipts)
            .set({ ocrData: extracted })
            .where(eq(receipts.id, row.receipts[0].id));
        }
      }
    }

    res.json({
      dryRun: body.dryRun,
      warnings,
      totals: {
        created: report.totals.imported,
        updated: 0,
        skipped: report.totals.skipped,
        failed: report.totals.failed,
      },
      results: report.results.map((r) => ({
        sourceRefId: r.externalId,
        status: r.status === 'imported' ? 'created' : r.status,
        expenseId: r.midasExpenseId,
        reason: r.reason,
        error: r.error,
      })),
    });
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}));

export default router;
