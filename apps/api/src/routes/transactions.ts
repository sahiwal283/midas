import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index';
import {
  companies,
  purchaseOrders,
  receipts,
  transactions,
} from '../db/schema';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler, createError, forbidden, notFound } from '../middleware/error';
import { auditLog } from '../lib/audit';
import { partitionPoBulkApprove } from '../lib/bulkPoReview';
import { canCancelOrDeleteTransaction } from '../lib/expenseDelete';
import { upsertVendorByName } from '../lib/syncExpenseTransaction';
import { pushPurchaseOrderToZoho, replaceLineItems } from '../lib/zohoPoPush';
import { zoho } from '../lib/zoho';
import { env } from '../config/env';
import { assertActiveCompany } from '../lib/companies';
import { normalizeSourceType } from '../lib/sourceTypes';
import { listItemsWithCache, listVendorsWithCache } from '../lib/zohoCatalog';
import { roleAllowed } from '../lib/roles';

const router = Router();
router.use(authenticate);

const lineItemSchema = z.object({
  lineNumber: z.number().int().positive(),
  description: z.string().min(1),
  quantity: z.coerce.number().positive(),
  unit: z.string().optional().nullable(),
  unitPrice: z.coerce.number().nonnegative(),
  tax: z.coerce.number().nonnegative().optional().default(0),
  total: z.coerce.number().nonnegative(),
  zohoItemId: z.string().optional().nullable(),
  ocrConfidence: z.coerce.number().min(0).max(1).optional().nullable(),
  needsReview: z.boolean().optional(),
});

const createPoSchema = z.object({
  vendorName: z.string().min(1),
  transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.string().length(3).default('USD'),
  taxTotal: z.coerce.number().nonnegative().optional().default(0),
  total: z.coerce.number().nonnegative().optional(),
  description: z.string().optional().nullable(),
  zohoEntity: z.string().optional().nullable(),
  poNumber: z.string().optional().nullable(),
  zohoVendorId: z.string().optional().nullable(),
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  notes: z.string().optional().nullable(),
  lineItems: z.array(lineItemSchema).default([]),
});

function sumLineTotals(items: z.infer<typeof lineItemSchema>[]): number {
  return items.reduce((acc, li) => acc + Number(li.total), 0);
}

router.get('/meta/vendors', asyncHandler(async (_req, res) => {
  const { vendors, source } = await listVendorsWithCache(env.ZOHO_DEFAULT_BRAND);
  res.json({ vendors, source });
}));

router.get('/meta/items', asyncHandler(async (_req, res) => {
  const { items, source } = await listItemsWithCache(env.ZOHO_DEFAULT_BRAND);
  res.json({ items, source });
}));

/** Force refresh Zoho vendor/item cache (accountant/admin). */
router.post('/meta/sync-catalog', requireRole('accountant', 'admin'), asyncHandler(async (_req, res) => {
  const [vendorsResult, itemsResult] = await Promise.all([
    listVendorsWithCache(env.ZOHO_DEFAULT_BRAND),
    listItemsWithCache(env.ZOHO_DEFAULT_BRAND),
  ]);
  res.json({
    vendors: { count: vendorsResult.vendors.length, source: vendorsResult.source },
    items: { count: itemsResult.items.length, source: itemsResult.source },
  });
}));

const bulkIdsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
});

const bulkPoReviewSchema = bulkIdsSchema.extend({
  action: z.literal('approve'),
});

/** Bulk-approve purchase orders (submitted/in_review only). UI excludes flagged rows first. */
router.post('/bulk-review', requireRole('accountant', 'admin'), asyncHandler(async (req, res) => {
  const { ids } = bulkPoReviewSchema.parse(req.body);
  const rows = await db.query.transactions.findMany({
    where: inArray(transactions.id, ids),
    with: { purchaseOrder: true, lineItems: true },
  });
  const { approvable, skipped } = partitionPoBulkApprove(
    rows.map((r) => ({
      id: r.id,
      type: r.type,
      status: r.status,
      total: r.total,
      integrationStatus: r.integrationStatus,
      zohoRecordId: r.zohoRecordId,
      purchaseOrder: r.purchaseOrder,
      lineItems: r.lineItems,
    })),
    ids,
  );

  const approved: string[] = [];
  const now = new Date();
  for (const id of approvable) {
    const tx = rows.find((r) => r.id === id)!;
    const txCompany = tx.zohoEntity
      ? await db.query.companies.findFirst({ where: eq(companies.name, tx.zohoEntity) })
      : undefined;
    const txZohoOn = txCompany?.zohoEnabled !== false && !!tx.zohoEntity;
    await db.update(transactions)
      .set({
        status: 'approved',
        integrationStatus: txZohoOn ? 'pending' : 'not_required',
        reviewedById: req.user!.id,
        reviewedAt: now,
        updatedAt: now,
      })
      .where(eq(transactions.id, id));
    await auditLog({
      entityType: 'transaction',
      entityId: id,
      userId: req.user!.id,
      action: 'review.approve',
      before: { status: tx.status },
      after: { status: 'approved' },
      metadata: { bulk: true },
    });
    approved.push(id);
  }

  res.json({ approved, skipped });
}));

/** Bulk Zoho push for purchase orders (sequential). */
router.post('/bulk-zoho-push', requireRole('accountant', 'admin'), asyncHandler(async (req, res) => {
  const { ids } = bulkIdsSchema.parse(req.body);
  const pushed: string[] = [];
  const failed: Array<{ id: string; code: string; message: string }> = [];

  for (const id of ids) {
    const outcome = await pushPurchaseOrderToZoho(id, req.user!.id);
    if (outcome.ok) {
      pushed.push(id);
      continue;
    }
    failed.push({ id, code: outcome.code, message: outcome.message });
  }

  res.json({ pushed, failed });
}));

/** List current user's transactions (optional type filter). */
router.get('/', asyncHandler(async (req, res) => {
  const type = req.query.type === 'purchase_order' || req.query.type === 'expense'
    ? req.query.type
    : undefined;
  const conds = [eq(transactions.userId, req.user!.id)];
  if (type) conds.push(eq(transactions.type, type));

  const rows = await db.query.transactions.findMany({
    where: and(...conds),
    with: {
      purchaseOrder: true,
      expenseDetails: true,
      lineItems: true,
      vendor: true,
    },
    orderBy: [desc(transactions.createdAt)],
  });
  res.json({ transactions: rows });
}));

/** Accountant: list all transactions with optional type filter. */
router.get('/all', requireRole('accountant', 'admin'), asyncHandler(async (req, res) => {
  const type = req.query.type === 'purchase_order' || req.query.type === 'expense'
    ? req.query.type
    : undefined;
  const conds = type ? [eq(transactions.type, type)] : [];
  const rows = await db.query.transactions.findMany({
    where: conds.length ? and(...conds) : undefined,
    with: {
      user: { columns: { id: true, name: true, email: true } },
      purchaseOrder: true,
      expenseDetails: true,
      lineItems: true,
      vendor: true,
    },
    orderBy: [desc(transactions.createdAt)],
  });
  res.json({ transactions: rows });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const row = await db.query.transactions.findFirst({
    where: eq(transactions.id, req.params.id),
    with: {
      user: { columns: { id: true, name: true, email: true } },
      purchaseOrder: true,
      expenseDetails: true,
      lineItems: true,
      vendor: true,
    },
  });
  if (!row) throw notFound('Transaction not found');
  const isOwner = row.userId === req.user!.id;
  const isPrivileged = roleAllowed(req.user!.role, ['accountant', 'admin']);
  if (!isOwner && !isPrivileged) throw forbidden();
  res.json({ transaction: row });
}));

/** Create a purchase-order transaction with optional line items. */
router.post('/purchase-orders', asyncHandler(async (req, res) => {
  const body = createPoSchema.parse(req.body);
  const lineItems = body.lineItems;
  const total = body.total ?? sumLineTotals(lineItems);
  const zohoEntity = await assertActiveCompany(body.zohoEntity ?? null);
  const vendor = await upsertVendorByName(body.vendorName, zohoEntity);
  const createCompany = zohoEntity
    ? await db.query.companies.findFirst({ where: eq(companies.name, zohoEntity) })
    : undefined;
  const createZohoOn = createCompany?.zohoEnabled !== false && !!zohoEntity;

  const [tx] = await db.insert(transactions).values({
    type: 'purchase_order',
    userId: req.user!.id,
    vendorId: vendor?.id ?? null,
    vendorName: body.vendorName,
    transactionDate: body.transactionDate,
    currency: body.currency,
    total: String(total),
    taxTotal: String(body.taxTotal ?? 0),
    description: body.description ?? null,
    status: 'draft',
    integrationStatus: createZohoOn ? 'pending' : 'not_required',
    zohoEntity,
    sourceType: normalizeSourceType('purchase_order'),
  }).returning();

  await db.insert(purchaseOrders).values({
    transactionId: tx.id,
    poNumber: body.poNumber ?? null,
    zohoVendorId: body.zohoVendorId ?? null,
    deliveryDate: body.deliveryDate ?? null,
    notes: body.notes ?? null,
  });

  if (lineItems.length) {
    await replaceLineItems(
      tx.id,
      lineItems.map((li) => ({
        lineNumber: li.lineNumber,
        description: li.description,
        quantity: String(li.quantity),
        unit: li.unit ?? null,
        unitPrice: String(li.unitPrice),
        tax: String(li.tax ?? 0),
        total: String(li.total),
        zohoItemId: li.zohoItemId ?? null,
        ocrConfidence: li.ocrConfidence != null ? String(li.ocrConfidence) : null,
        needsReview: li.needsReview ?? false,
      })),
    );
  }

  await auditLog({
    entityType: 'transaction',
    entityId: tx.id,
    userId: req.user!.id,
    action: 'po.created',
    after: tx,
  });

  const full = await db.query.transactions.findFirst({
    where: eq(transactions.id, tx.id),
    with: { purchaseOrder: true, lineItems: true, vendor: true },
  });
  res.status(201).json({ transaction: full });
}));

const updatePoSchema = createPoSchema.partial().extend({
  lineItems: z.array(lineItemSchema).optional(),
});

router.patch('/:id', asyncHandler(async (req, res) => {
  const existing = await db.query.transactions.findFirst({
    where: eq(transactions.id, req.params.id),
    with: { purchaseOrder: true },
  });
  if (!existing) throw notFound('Transaction not found');
  if (existing.userId !== req.user!.id && req.user!.role !== 'accountant' && req.user!.role !== 'admin') {
    throw forbidden();
  }
  if (existing.type !== 'purchase_order') {
    throw createError('Use expense APIs for expense transactions', 400, 'WRONG_TYPE');
  }

  const body = updatePoSchema.parse(req.body);
  const privileged = roleAllowed(req.user!.role, ['accountant', 'admin']);
  const ownerEditable = existing.status === 'draft' || existing.status === 'awaiting_info';
  const mappingOnly = privileged
    && existing.status === 'approved'
    && existing.integrationStatus !== 'synced'
    && !existing.zohoRecordId
    && (body.zohoVendorId !== undefined || body.lineItems !== undefined)
    && body.vendorName === undefined
    && body.transactionDate === undefined
    && body.total === undefined
    && body.taxTotal === undefined
    && body.description === undefined;

  if (!ownerEditable && !mappingOnly) {
    throw createError('Only draft or awaiting_info transactions can be edited', 409, 'NOT_EDITABLE');
  }

  const zohoEntity = body.zohoEntity !== undefined
    ? await assertActiveCompany(body.zohoEntity)
    : existing.zohoEntity;

  const vendorName = body.vendorName ?? existing.vendorName;
  const vendor = body.vendorName
    ? await upsertVendorByName(body.vendorName, zohoEntity)
    : null;

  let total = existing.total;
  if (ownerEditable) {
    if (body.total !== undefined) total = String(body.total);
    else if (body.lineItems) total = String(sumLineTotals(body.lineItems));
  }

  const [updated] = await db.update(transactions)
    .set(ownerEditable ? {
      vendorName,
      vendorId: vendor?.id ?? existing.vendorId,
      transactionDate: body.transactionDate ?? existing.transactionDate,
      currency: body.currency ?? existing.currency,
      taxTotal: body.taxTotal !== undefined ? String(body.taxTotal) : existing.taxTotal,
      total,
      description: body.description !== undefined ? body.description : existing.description,
      zohoEntity: body.zohoEntity !== undefined ? zohoEntity : existing.zohoEntity,
      updatedAt: new Date(),
    } : {
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, existing.id))
    .returning();

  if (body.poNumber !== undefined || body.zohoVendorId !== undefined || body.deliveryDate !== undefined || body.notes !== undefined) {
    await db.update(purchaseOrders)
      .set({
        poNumber: body.poNumber !== undefined && ownerEditable ? body.poNumber : existing.purchaseOrder?.poNumber,
        zohoVendorId: body.zohoVendorId !== undefined ? body.zohoVendorId : existing.purchaseOrder?.zohoVendorId,
        deliveryDate: body.deliveryDate !== undefined && ownerEditable ? body.deliveryDate : existing.purchaseOrder?.deliveryDate,
        notes: body.notes !== undefined && ownerEditable ? body.notes : existing.purchaseOrder?.notes,
      })
      .where(eq(purchaseOrders.transactionId, existing.id));
  }

  if (body.lineItems) {
    await replaceLineItems(
      existing.id,
      body.lineItems.map((li) => ({
        lineNumber: li.lineNumber,
        description: li.description,
        quantity: String(li.quantity),
        unit: li.unit ?? null,
        unitPrice: String(li.unitPrice),
        tax: String(li.tax ?? 0),
        total: String(li.total),
        zohoItemId: li.zohoItemId ?? null,
        ocrConfidence: li.ocrConfidence != null ? String(li.ocrConfidence) : null,
        needsReview: li.needsReview ?? false,
      })),
    );
  }

  const full = await db.query.transactions.findFirst({
    where: eq(transactions.id, existing.id),
    with: { purchaseOrder: true, lineItems: true, vendor: true },
  });
  res.json({ transaction: full ?? updated });
}));

router.post('/:id/submit', asyncHandler(async (req, res) => {
  const existing = await db.query.transactions.findFirst({
    where: eq(transactions.id, req.params.id),
    with: { lineItems: true },
  });
  if (!existing) throw notFound('Transaction not found');
  if (existing.userId !== req.user!.id) throw forbidden();
  if (existing.status !== 'draft') {
    throw createError('Only drafts can be submitted', 409, 'CONFLICT');
  }
  if (existing.type === 'purchase_order' && (!existing.lineItems || existing.lineItems.length === 0)) {
    throw createError('Add at least one line item before submitting', 409, 'MISSING_LINE_ITEMS');
  }

  // Purchase orders skip accountant review entirely: the purchasing employee
  // is the authority. Submit = approve + push to Zoho immediately (unless the
  // company has Zoho disabled — then it just becomes approved).
  if (existing.type === 'purchase_order') {
    const company = existing.zohoEntity
      ? await db.query.companies.findFirst({ where: eq(companies.name, existing.zohoEntity) })
      : undefined;
    const zohoOn = company?.zohoEnabled !== false && !!existing.zohoEntity;

    const [approved] = await db.update(transactions)
      .set({
        status: 'approved',
        integrationStatus: zohoOn ? 'pending' : existing.integrationStatus,
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, existing.id))
      .returning();

    await auditLog({
      entityType: 'transaction',
      entityId: existing.id,
      userId: req.user!.id,
      action: 'auto_approved',
      before: { status: 'draft' },
      after: { status: 'approved' },
      metadata: { reason: 'purchase orders skip review', zohoPush: zohoOn },
    });

    if (zohoOn) {
      const outcome = await pushPurchaseOrderToZoho(existing.id, req.user!.id);
      const fresh = await db.query.transactions.findFirst({ where: eq(transactions.id, existing.id) });
      res.json({ transaction: fresh ?? approved, autoPushed: outcome.ok });
      return;
    }

    res.json({ transaction: approved, autoPushed: false });
    return;
  }

  const submitCompany = existing.zohoEntity
    ? await db.query.companies.findFirst({ where: eq(companies.name, existing.zohoEntity) })
    : undefined;
  const submitZohoOn = submitCompany?.zohoEnabled !== false && !!existing.zohoEntity;

  const [updated] = await db.update(transactions)
    .set({
      status: 'submitted',
      integrationStatus: submitZohoOn ? 'pending' : existing.integrationStatus,
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, existing.id))
    .returning();

  await auditLog({
    entityType: 'transaction',
    entityId: existing.id,
    userId: req.user!.id,
    action: 'submitted',
    before: { status: 'draft' },
    after: { status: 'submitted' },
  });
  res.json({ transaction: updated });
}));

router.post('/:id/cancel', asyncHandler(async (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true';
  const existing = await db.query.transactions.findFirst({
    where: eq(transactions.id, req.params.id),
  });
  if (!existing) throw notFound('Transaction not found');

  const decision = canCancelOrDeleteTransaction({
    role: req.user!.role,
    actorUserId: req.user!.id,
    force,
    transaction: {
      userId: existing.userId,
      status: existing.status,
      reviewedAt: existing.reviewedAt,
      zohoRecordId: existing.zohoRecordId,
      integrationStatus: existing.integrationStatus,
    },
  });
  if (!decision.ok) throw createError(decision.message, decision.status, decision.code);

  if (decision.mode === 'hard_delete') {
    await db.delete(transactions).where(eq(transactions.id, existing.id));
    await auditLog({
      entityType: 'transaction',
      entityId: existing.id,
      userId: req.user!.id,
      action: 'deleted',
      before: { status: existing.status },
    });
    res.json({ ok: true, mode: 'hard_delete' });
    return;
  }

  const [updated] = await db.update(transactions)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(transactions.id, existing.id))
    .returning();
  await auditLog({
    entityType: 'transaction',
    entityId: existing.id,
    userId: req.user!.id,
    action: 'cancelled',
    before: { status: existing.status },
    after: { status: 'cancelled' },
  });
  res.json({ ok: true, mode: 'soft_cancel', transaction: updated });
}));

router.post('/:id/review', requireRole('accountant', 'admin'), asyncHandler(async (req, res) => {
  const body = z.object({
    action: z.enum(['approve', 'reject', 'request_info']),
    note: z.string().optional(),
    zohoEntity: z.string().optional(),
  }).parse(req.body);

  const existing = await db.query.transactions.findFirst({
    where: eq(transactions.id, req.params.id),
  });
  if (!existing) throw notFound('Transaction not found');
  if (!['submitted', 'in_review', 'awaiting_info'].includes(existing.status)) {
    throw createError(`Cannot review from status '${existing.status}'`, 409, 'CONFLICT');
  }

  const newStatus = body.action === 'approve' ? 'approved'
    : body.action === 'reject' ? 'rejected'
    : 'awaiting_info';

  const reviewEffectiveCompany = body.zohoEntity ?? existing.zohoEntity;
  const reviewCompany = reviewEffectiveCompany
    ? await db.query.companies.findFirst({ where: eq(companies.name, reviewEffectiveCompany) })
    : undefined;
  const reviewZohoOn = reviewCompany?.zohoEnabled !== false && !!reviewEffectiveCompany;

  const [updated] = await db.update(transactions)
    .set({
      status: newStatus,
      zohoEntity: body.zohoEntity ?? existing.zohoEntity,
      integrationStatus: body.action === 'approve'
        ? (reviewZohoOn ? 'pending' : 'not_required')
        : existing.integrationStatus,
      reviewedById: req.user!.id,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, existing.id))
    .returning();

  await auditLog({
    entityType: 'transaction',
    entityId: existing.id,
    userId: req.user!.id,
    action: `review.${body.action}`,
    before: { status: existing.status },
    after: { status: newStatus },
    metadata: { note: body.note },
  });
  res.json({ transaction: updated });
}));

router.post('/:id/zoho-push', requireRole('accountant', 'admin'), asyncHandler(async (req, res) => {
  const outcome = await pushPurchaseOrderToZoho(req.params.id, req.user!.id);
  if (outcome.ok) {
    res.json({ transaction: outcome.transaction, zoho: outcome.zoho });
    return;
  }
  if (outcome.status === 409) throw createError(outcome.message, 409, outcome.code);
  res.status(502).json({
    error: { code: outcome.code, message: outcome.message, requestId: outcome.requestId },
  });
}));

/** Persist OCR-derived line items onto a PO transaction (Phase 1 foundation). */
router.post('/:id/ocr-line-items', asyncHandler(async (req, res) => {
  const body = z.object({
    lineItems: z.array(lineItemSchema).min(1),
    taxTotal: z.coerce.number().nonnegative().optional(),
    total: z.coerce.number().nonnegative().optional(),
    vendorName: z.string().optional(),
  }).parse(req.body);

  const existing = await db.query.transactions.findFirst({
    where: eq(transactions.id, req.params.id),
  });
  if (!existing) throw notFound('Transaction not found');
  if (existing.userId !== req.user!.id && req.user!.role !== 'accountant' && req.user!.role !== 'admin') {
    throw forbidden();
  }
  if (existing.type !== 'purchase_order') {
    throw createError('OCR line items apply to purchase orders', 400, 'WRONG_TYPE');
  }

  await replaceLineItems(
    existing.id,
    body.lineItems.map((li) => ({
      lineNumber: li.lineNumber,
      description: li.description,
      quantity: String(li.quantity),
      unit: li.unit ?? null,
      unitPrice: String(li.unitPrice),
      tax: String(li.tax ?? 0),
      total: String(li.total),
      zohoItemId: li.zohoItemId ?? null,
      ocrConfidence: li.ocrConfidence != null ? String(li.ocrConfidence) : null,
      needsReview: li.needsReview ?? (li.ocrConfidence != null && li.ocrConfidence < 0.7),
    })),
  );

  const total = body.total ?? sumLineTotals(body.lineItems);
  const [updated] = await db.update(transactions)
    .set({
      vendorName: body.vendorName ?? existing.vendorName,
      taxTotal: body.taxTotal !== undefined ? String(body.taxTotal) : existing.taxTotal,
      total: String(total),
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, existing.id))
    .returning();

  // Touch receipts so callers know OCR confirmation happened
  await db.update(receipts)
    .set({ ocrNeedsReview: false })
    .where(and(
      eq(receipts.expenseId, existing.id),
      eq(receipts.ocrNeedsReview, true),
    ));

  const full = await db.query.transactions.findFirst({
    where: eq(transactions.id, existing.id),
    with: { lineItems: true, purchaseOrder: true },
  });
  res.json({ transaction: full ?? updated });
}));

export default router;
