/**
 * External app-to-app API (`/api/v1/ext/*`).
 * Spec: docs/EXT_API_MERGE_LOCK.md
 */
import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  and, asc, eq, gt, gte, ilike, lte, notInArray, or, sql,
} from 'drizzle-orm';
import { ImportService, type ImportRecord } from '@midas/import';
import { db } from '../db/index';
import {
  companies,
  expenseCategories,
  expenseMessages,
  expenses,
  paymentMethods,
  receipts,
  users,
  type ExpenseSourceContext,
} from '../db/schema';
import { authenticateApiKey } from '../middleware/auth';
import { requireScope } from '../middleware/requireScope';
import { asyncHandler, createError, notFound } from '../middleware/error';
import { auditLog } from '../lib/audit';
import { assertActiveCompany } from '../lib/companies';
import { decideThreadPost } from '../lib/expenseThread';
import { listThread, postToThread } from '../lib/expenseThreadDb';
import { resolveCategoryIdOrOther } from '../lib/ext/categories';
import { applyVocabulary } from '../lib/ext/categoryVocabulary';
import { allowedCategoryIds } from '../lib/ext/categoryVocabularyDb';
import { EXT_EXPENSE_WITH, toExtExpenseDto } from '../lib/ext/dto';
import { duplicateDateWindow, findDuplicateMatches, type ExtWarning } from '../lib/ext/extWarnings';
import { ExtImportTargetPort } from '../lib/ext/importTarget';
import { mapImportExpenseStatus, mapImportReimbursementStatus } from '../lib/ext/maps';
import { toExtMessageDto } from '../lib/ext/messageDto';
import { nextReimbursementOnCardLink } from '../lib/reimbursement';
import { resolveExtUser } from '../lib/ext/users';
import { ocr } from '../lib/ocr';
import { runReceiptOcr } from '../lib/runReceiptOcr';
import { storage } from '../lib/storage';
import { env } from '../config/env';
import { normalizeReferenceNumber, pickReferenceNumber } from '@midas/shared';

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

/** X-Actor-Username header or body submitterUsername. Preferred over email. */
function actorUsername(req: { body?: { submitterUsername?: string }; headers: Record<string, unknown> }): string | undefined {
  const header = req.headers['x-actor-username'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (typeof req.body?.submitterUsername === 'string') return req.body.submitterUsername.trim();
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

// Only the categories this connection is scoped to. A connection with no
// allowlist rows is unrestricted, so consumers keep their own vocabulary
// instead of inheriting every category Midas happens to define.
router.get('/categories', requireScope('expenses:read'), asyncHandler(async (req, res) => {
  const rows = await db.query.expenseCategories.findMany({
    where: eq(expenseCategories.isActive, true),
    orderBy: [asc(expenseCategories.name)],
  });
  const allowed = req.appConnection ? await allowedCategoryIds(req.appConnection.id) : null;
  res.json({
    categories: applyVocabulary(rows, allowed).map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      isActive: c.isActive,
    })),
  });
}));

// Payment methods catalog (Trade Show cardOptions → Midas SoR)
router.get('/payment-methods', requireScope('expenses:read'), asyncHandler(async (_req, res) => {
  const rows = await db.query.paymentMethods.findMany({
    where: and(eq(paymentMethods.isActive, true), eq(paymentMethods.isCompanyWide, true)),
    orderBy: [asc(paymentMethods.label), asc(paymentMethods.lastFour)],
  });
  res.json({
    paymentMethods: rows.map((pm) => ({
      id: pm.id,
      label: pm.label,
      lastFour: pm.lastFour,
      brand: pm.brand,
      /** Preferred name; `defaultZohoEntity` is the deprecated alias. */
      defaultCompany: pm.defaultZohoEntity,
      defaultZohoEntity: pm.defaultZohoEntity,
      requiresReimbursement: pm.requiresReimbursement,
      /** Alias for Trade Show `zohoPaymentAccountId` — Zoho Books paid-through account id/name. */
      zohoPaymentAccountId: pm.zohoAccountName,
      zohoAccountName: pm.zohoAccountName,
    })),
  });
}));

// Companies catalog (Trade Show entityOptions → Midas SoR).
// `name` is the identifier: expenses.zoho_entity stores the company NAME and
// consumers already send names, so there is no id translation to get wrong.
// Non-Zoho companies are included with zohoEnabled:false — Midas stays
// app-agnostic and lets the consumer decide whether to offer them.
router.get('/companies', requireScope('expenses:read'), asyncHandler(async (_req, res) => {
  const rows = await db.query.companies.findMany({
    where: eq(companies.isActive, true),
    orderBy: [asc(companies.sortOrder), asc(companies.name)],
  });
  res.json({
    companies: rows.map((c) => ({
      name: c.name,
      zohoEnabled: c.zohoEnabled,
      sortOrder: c.sortOrder,
    })),
  });
}));

// Cutover self-check: the three vocabulary counts a consumer should confirm
// before switching over, in one call instead of three plus manual counting.
router.get('/health/vocabulary', requireScope('expenses:read'), asyncHandler(async (req, res) => {
  const allCats = await db.query.expenseCategories.findMany({
    where: eq(expenseCategories.isActive, true),
  });
  const allowed = req.appConnection ? await allowedCategoryIds(req.appConnection.id) : null;
  const visibleCategories = applyVocabulary(allCats, allowed);

  const [pmRows, companyRows] = await Promise.all([
    db.query.paymentMethods.findMany({
      where: and(eq(paymentMethods.isActive, true), eq(paymentMethods.isCompanyWide, true)),
    }),
    db.query.companies.findMany({ where: eq(companies.isActive, true) }),
  ]);

  res.json({
    appName: req.appConnection?.appName ?? null,
    categories: {
      visible: visibleCategories.length,
      totalActiveInMidas: allCats.length,
      scoped: allowed !== null,
    },
    paymentMethods: { visible: pmRows.length },
    companies: {
      visible: companyRows.length,
      zohoEnabled: companyRows.filter((c) => c.zohoEnabled).length,
    },
  });
}));

// ── Standalone OCR ───────────────────────────────────────────────────────────

router.post('/ocr/process', requireScope('ocr:process'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw createError('No file uploaded', 400, 'NO_FILE');

  const requestId = (typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'])
    || (typeof req.headers['x-correlation-id'] === 'string' && req.headers['x-correlation-id'])
    || randomUUID();
  res.setHeader('X-Request-Id', requestId);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'midas-ext-ocr-'));
  const tmpPath = path.join(tmpDir, req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_'));
  try {
    await fs.writeFile(tmpPath, req.file.buffer);
    const result = await ocr.process(tmpPath, `ext-ocr-${Date.now()}`);
    const amountRaw = result.fields.amount?.value;
    const amountNum = amountRaw != null && amountRaw !== '' ? Number(amountRaw) : null;
    const referenceNumber = pickReferenceNumber({
      field: result.fields.referenceNumber?.value,
      text: result.text,
    });

    res.json({
      ocrMode: 'sync',
      requestId: result.requestId || requestId,
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
        referenceNumber: {
          value: referenceNumber,
          confidence: result.fields.referenceNumber?.confidence ?? (referenceNumber ? 0.7 : 0),
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
  /** Preferred over submitterEmail — works for users with no email address. */
  submitterUsername: z.string().min(1).optional(),
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
  referenceNumber: z.string().max(80).optional().nullable(),
  categoryId: z.string().uuid().optional().nullable(),
  categoryName: z.string().optional().nullable(),
  paymentMethodId: z.string().uuid().optional().nullable(),
  cardUsed: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  reimbursementRequired: z.boolean().optional(),
  status: expenseStatusEnum.optional(),
  /** Company that paid. `zohoEntity` is the deprecated alias; `company` wins if both are sent. */
  company: z.string().optional().nullable(),
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
    res.status(200).json({
      expense, midasUrl: expense.midasUrl, created: false, warnings: [],
    });
    return;
  }

  const username = actorUsername(req) ?? body.submitterUsername;
  const email = actorEmail(req) ?? body.submitterEmail;
  if (!username && !email) {
    throw createError('submitterUsername or submitterEmail is required', 400, 'VALIDATION_ERROR');
  }

  const user = await resolveExtUser({ username, email, displayName: actorName(req) });
  const externalUserId = actorExternalUserId(req);

  const warnings: ExtWarning[] = [];

  const resolvedCat = await resolveCategoryIdOrOther({
    sourceApp: body.sourceApp,
    categoryId: body.categoryId,
    categoryName: body.categoryName,
  });
  const categoryId = resolvedCat.categoryId;
  if (resolvedCat.warning) {
    warnings.push({ code: 'CATEGORY_FALLBACK', message: resolvedCat.warning });
  }

  const company = await assertActiveCompany(body.company ?? body.zohoEntity);

  // Bounded by date rather than row count: isLikelyDuplicate can only match
  // within DUPLICATE_DATE_TOLERANCE_DAYS, so a row outside this window can
  // never be a candidate, and the window keeps the result set small without
  // risking an arbitrary, unordered truncation of a large history.
  const dupWindow = duplicateDateWindow(body.date);
  const candidates = await db.query.expenses.findMany({
    columns: { id: true, merchant: true, amount: true, date: true },
    where: and(
      eq(expenses.userId, user.id),
      notInArray(expenses.status, ['draft', 'rejected', 'cancelled']),
      gte(expenses.date, dupWindow.from),
      lte(expenses.date, dupWindow.to),
    ),
  });
  const matches = findDuplicateMatches(
    { merchant: body.merchant, amount: body.amount, date: body.date },
    candidates,
  );
  if (matches.length) {
    warnings.push({
      code: 'POSSIBLE_DUPLICATE',
      message: `${matches.length} existing expense(s) look like this one`,
      matches,
    });
  }

  const sourceContext: ExpenseSourceContext = {
    ...(body.metadata ?? {}),
    ...(body.eventId ? { eventId: body.eventId } : {}),
    ...(body.sourceLabel ? { eventName: body.sourceLabel } : {}),
    location: body.location ?? null,
    cardUsed: body.cardUsed ?? null,
    ...(externalUserId ? { externalUserId } : {}),
  };

  let reimbursementStatus = mapImportReimbursementStatus(undefined, body.reimbursementRequired);
  if (body.paymentMethodId && body.reimbursementRequired === undefined) {
    const pm = await db.query.paymentMethods.findFirst({
      where: eq(paymentMethods.id, body.paymentMethodId),
    });
    const next = nextReimbursementOnCardLink(reimbursementStatus, pm);
    if (next) reimbursementStatus = next as typeof reimbursementStatus;
  }

  const [inserted] = await db.insert(expenses).values({
    userId: user.id,
    merchant: body.merchant,
    amount: String(body.amount),
    currency: body.currency,
    date: body.date,
    categoryId,
    paymentMethodId: body.paymentMethodId ?? null,
    description: body.description ?? null,
    referenceNumber: normalizeReferenceNumber(body.referenceNumber),
    sourceApp: body.sourceApp,
    sourceRefId: body.sourceRefId,
    sourceLabel: body.sourceLabel ?? null,
    sourceUrl: body.sourceUrl || null,
    sourceType: body.sourceType ?? null,
    sourceContext,
    externalUserId,
    status: body.status ?? 'pending',
    reimbursementStatus,
    zohoEntity: company,
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
  res.status(201).json({
    expense, midasUrl: expense!.midasUrl, created: true, warnings,
  });
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
  referenceNumber: z.string().max(80).nullable().optional(),
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
  company: z.string().nullable().optional(),
  /** @deprecated alias of `company`. */
  zohoEntity: z.string().nullable().optional(),
});

router.patch('/expenses/:id', requireScope('expenses:update'), asyncHandler(async (req, res) => {
  const body = patchSchema.parse(req.body);
  const existing = await db.query.expenses.findFirst({ where: eq(expenses.id, req.params.id) });
  if (!existing) throw notFound('Expense not found');

  const editable = new Set(['draft', 'pending', 'awaiting_info']);
  if (!editable.has(existing.status)) {
    throw createError(`Expense status ${existing.status} is not editable`, 409, 'CONFLICT');
  }

  const warnings: ExtWarning[] = [];

  let categoryId = body.categoryId;
  if (categoryId === undefined && body.categoryName !== undefined) {
    const resolved = await resolveCategoryIdOrOther({
      sourceApp: existing.sourceApp,
      categoryName: body.categoryName,
    });
    categoryId = resolved.categoryId;
    if (resolved.warning) {
      warnings.push({ code: 'CATEGORY_FALLBACK', message: resolved.warning });
    }
  }

  let company: string | null | undefined;
  if (body.company !== undefined || body.zohoEntity !== undefined) {
    company = await assertActiveCompany(body.company ?? body.zohoEntity);
  }

  const ctx: ExpenseSourceContext = { ...(existing.sourceContext ?? {}) };
  if (body.eventId !== undefined) {
    if (body.eventId) ctx.eventId = body.eventId;
    else delete ctx.eventId;
  }
  if (body.location !== undefined) ctx.location = body.location;
  if (body.cardUsed !== undefined) ctx.cardUsed = body.cardUsed;
  if (body.sourceLabel !== undefined && body.sourceLabel) ctx.eventName = body.sourceLabel;

  if (body.merchant !== undefined || body.amount !== undefined || body.date !== undefined) {
    const candidateMerchant = body.merchant ?? existing.merchant;
    const candidateAmount = body.amount ?? Number(existing.amount);
    const candidateDate = body.date ?? existing.date;
    // Same date-window rationale as the create path — bounded by the merged
    // (patch-or-existing) date rather than an unordered row-count cap, so
    // self-exclusion below can never shrink the effective set below complete.
    const dupWindow = duplicateDateWindow(candidateDate);
    const candidateRows = await db.query.expenses.findMany({
      columns: { id: true, merchant: true, amount: true, date: true },
      where: and(
        eq(expenses.userId, existing.userId),
        notInArray(expenses.status, ['draft', 'rejected', 'cancelled']),
        gte(expenses.date, dupWindow.from),
        lte(expenses.date, dupWindow.to),
      ),
    });
    const matches = findDuplicateMatches(
      { merchant: candidateMerchant, amount: candidateAmount, date: candidateDate },
      candidateRows.filter((c) => c.id !== existing.id),
    );
    if (matches.length) {
      warnings.push({
        code: 'POSSIBLE_DUPLICATE',
        message: `${matches.length} existing expense(s) look like this one`,
        matches,
      });
    }
  }

  const [updated] = await db.update(expenses).set({
    ...(body.merchant !== undefined ? { merchant: body.merchant } : {}),
    ...(body.amount !== undefined ? { amount: String(body.amount) } : {}),
    ...(body.currency !== undefined ? { currency: body.currency } : {}),
    ...(body.date !== undefined ? { date: body.date } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.referenceNumber !== undefined
      ? { referenceNumber: normalizeReferenceNumber(body.referenceNumber) }
      : {}),
    ...(categoryId !== undefined ? { categoryId } : {}),
    ...(body.paymentMethodId !== undefined ? { paymentMethodId: body.paymentMethodId } : {}),
    ...(body.sourceLabel !== undefined ? { sourceLabel: body.sourceLabel } : {}),
    ...(body.sourceUrl !== undefined ? { sourceUrl: body.sourceUrl } : {}),
    ...(body.status !== undefined ? { status: body.status } : {}),
    ...(company !== undefined ? { zohoEntity: company } : {}),
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
  res.json({ expense, midasUrl: expense!.midasUrl, warnings });
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

// ── Messages ─────────────────────────────────────────────────────────────────

/**
 * A trade_show key must not read or write conversations on another app's
 * expenses. Note GET /ext/expenses/:id does not scope this way today; message
 * bodies are free-text human conversation and should not inherit that.
 */
async function loadScopedExpense(req: { params: { id: string }; appConnection?: { appName: string } }) {
  const expense = await db.query.expenses.findFirst({ where: eq(expenses.id, req.params.id) });
  if (!expense) throw notFound('Expense not found');
  if (expense.sourceApp !== req.appConnection!.appName) throw notFound('Expense not found');
  return expense;
}

router.get('/expenses/:id/messages', requireScope('messages:read'), asyncHandler(async (req, res) => {
  await loadScopedExpense(req as never);
  // Ext consumers never see internal notes — see Decision 3 in the design doc.
  // Sender email IS included: a consumer keys its own users by email, and Midas
  // user ids mean nothing to it (see toExtMessageDto).
  const rows = await listThread(req.params.id, {
    includeInternal: false,
    includeSenderEmail: true,
  });
  res.json({ messages: rows.map((r) => toExtMessageDto(r as never)) });
}));

const extPostMessageSchema = z.object({
  body: z.string().trim().min(1).max(2000),
  requestType: z.enum([
    'info_request', 'missing_receipt', 'missing_category', 'missing_payment_method', 'general',
  ]).optional(),
});

router.post('/expenses/:id/messages', requireScope('messages:write'), asyncHandler(async (req, res) => {
  const expense = await loadScopedExpense(req as never);
  const parsed = extPostMessageSchema.parse(req.body);

  // Posting a message must never conjure an account, even when
  // EXT_AUTO_PROVISION_USERS is on — that is for expense creation only.
  const actor = await resolveExtUser({
    email: actorEmail(req as never),
    username: actorUsername(req as never),
    displayName: actorName(req as never),
    autoProvision: false,
  });

  const senderRole = await db.query.users.findFirst({
    where: eq(users.id, actor.id),
    columns: { role: true },
  });
  const role = (senderRole?.role ?? 'user') as never;

  if (parsed.requestType) {
    const { mayRequestInfo } = decideThreadPost({
      status: expense.status,
      senderId: actor.id,
      senderRole: role,
      ownerId: expense.userId,
    });
    if (!mayRequestInfo) {
      throw createError('Sender may not set requestType', 403, 'FORBIDDEN');
    }
  }

  const message = await postToThread({
    expenseId: req.params.id,
    senderId: actor.id,
    senderRole: role,
    body: parsed.body,
    requestType: parsed.requestType ?? null,
  });
  if (!message) throw notFound('Expense not found');

  res.status(201).json({ message: toExtMessageDto(message as never) });
}));

/**
 * Cross-expense message feed for polling consumers. Keyset-paged on
 * (createdAt, id) with the same base64url {c,i} cursor as GET /ext/expenses.
 *
 * Each row inlines the expense context a notifier needs — without it a scanner
 * does an N+1 fetch per message just to write "your $340 expense at Ruth's Chris".
 */
router.get('/messages', requireScope('messages:read'), asyncHandler(async (req, res) => {
  const sourceApp = typeof req.query.sourceApp === 'string' ? req.query.sourceApp : undefined;
  if (!sourceApp) throw createError('sourceApp query param is required', 400, 'VALIDATION_ERROR');
  if (sourceApp !== req.appConnection!.appName) {
    throw createError('sourceApp does not match this connection', 403, 'FORBIDDEN');
  }

  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
  const conditions = [eq(expenses.sourceApp, sourceApp)];

  const since = typeof req.query.since === 'string' ? req.query.since : undefined;
  if (since) {
    try {
      const decoded = JSON.parse(Buffer.from(since, 'base64url').toString('utf8')) as { c: string; i: string };
      conditions.push(
        or(
          gt(expenseMessages.createdAt, new Date(decoded.c)),
          and(eq(expenseMessages.createdAt, new Date(decoded.c)), gt(expenseMessages.id, decoded.i)),
        )!,
      );
    } catch {
      throw createError('Invalid cursor', 400, 'VALIDATION_ERROR');
    }
  }

  const rows = await db.select({
    id: expenseMessages.id,
    body: expenseMessages.body,
    isSystem: expenseMessages.isSystem,
    requestType: expenseMessages.requestType,
    isResolved: expenseMessages.isResolved,
    resolvedAt: expenseMessages.resolvedAt,
    createdAt: expenseMessages.createdAt,
    senderId: users.id,
    senderName: users.name,
    senderRole: users.role,
    senderEmail: users.email,
    expenseId: expenses.id,
    sourceRefId: expenses.sourceRefId,
    ownerUserId: expenses.userId,
    externalUserId: expenses.externalUserId,
    merchant: expenses.merchant,
    amount: expenses.amount,
    status: expenses.status,
  })
    .from(expenseMessages)
    .innerJoin(expenses, eq(expenseMessages.expenseId, expenses.id))
    .innerJoin(users, eq(expenseMessages.senderId, users.id))
    .where(and(...conditions))
    .orderBy(asc(expenseMessages.createdAt), asc(expenseMessages.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  // Unlike GET /ext/expenses (a list), this is a resumable stream: a consumer
  // must be able to say "continue after the last row I saw". So the cursor is
  // the last row of the page whenever the page has rows, and null only when
  // there was nothing to return. Returning null on a final partial page would
  // leave a poller with no watermark and force it to replay from the start.
  const last = page[page.length - 1];
  const nextCursor = last
    ? Buffer.from(JSON.stringify({ c: last.createdAt.toISOString(), i: last.id }), 'utf8').toString('base64url')
    : null;

  res.json({
    messages: page.map((r) => ({
      id: r.id,
      body: r.body,
      sender: { id: r.senderId, name: r.senderName, role: r.senderRole, email: r.senderEmail },
      isSystem: r.isSystem,
      requestType: r.requestType,
      isResolved: r.isResolved,
      resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      expense: {
        id: r.expenseId,
        sourceRefId: r.sourceRefId,
        ownerUserId: r.ownerUserId,
        externalUserId: r.externalUserId,
        merchant: r.merchant,
        amount: r.amount,
        status: r.status,
      },
    })),
    nextCursor,
  });
}));

// ── Bulk import ──────────────────────────────────────────────────────────────

const importItemSchema = z.object({
  sourceRefId: z.string().min(1),
  submitterEmail: z.string().email(),
  submitterUsername: z.string().min(1).optional(),
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
  referenceNumber: z.string().max(80).optional().nullable(),
  categoryName: z.string().optional().nullable(),
  cardUsed: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  status: z.string().optional(),
  reimbursementRequired: z.boolean().optional(),
  reimbursementStatus: z.string().optional().nullable(),
  company: z.string().optional().nullable(),
  /** @deprecated alias of `company`. */
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
        zohoEntity: item.company ?? item.zohoEntity ?? null,
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
