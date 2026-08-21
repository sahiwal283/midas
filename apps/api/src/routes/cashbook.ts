// Cash drawers, merged from the standalone Cashbook app. Accountant-gated.
// Regular businesses keep their ledger in Midas Postgres; the payroll-linked
// business dispatches to lib/payrollDrawer.ts (ledger lives in the payroll
// app's database — payroll runs write withdrawals there).

import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import { Router, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { and, desc, eq, isNull, sql as dsql } from 'drizzle-orm';
import { db } from '../db/index';
import { cashBusinesses, cashDrawerEntries } from '../db/schema';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler, createError, notFound } from '../middleware/error';
import { auditLog } from '../lib/audit';
import { storage } from '../lib/storage';
import { env } from '../config/env';
import {
  PETTY_CASH_CATEGORY,
  buildLedgerCsv,
  localTodayIso,
  pettyCashNote,
  validateAmountCents,
  validateDeposit,
  validateEntryDate,
  validatePettyCash,
  type CsvEntry,
} from '../lib/cashLedger';
import {
  getPayrollDrawerTotals,
  isPayrollDrawerEnabled,
  listPayrollEntries,
  payrollAppUrl,
  recordPayrollDeposit,
  recordPayrollPettyCash,
  recordPayrollWithdrawal,
  voidPayrollEntry,
  type MidasActor,
} from '../lib/payrollDrawer';

const router = Router();
router.use(authenticate);
router.use(requireRole('accountant', 'admin'));

const RECEIPT_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (RECEIPT_MIME.has(file.mimetype)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: jpeg, png, webp, pdf`));
  },
});

function actor(req: { user?: { id: string; email: string | null; name: string } }): MidasActor {
  return { id: req.user!.id, email: req.user!.email, name: req.user!.name };
}

/** Cents from a "12.34"-style dollar string or number. Rejects NaN/negatives downstream. */
function toCents(amount: unknown): number {
  const n = typeof amount === 'string' ? Number(amount) : (amount as number);
  return Math.round(Number(n) * 100);
}

async function getBusiness(id: string) {
  const biz = await db.query.cashBusinesses.findFirst({ where: eq(cashBusinesses.id, id) });
  if (!biz || biz.archivedAt) throw notFound('Business not found');
  return biz;
}

async function localTotals(businessId: string) {
  const [row] = await db
    .select({
      deposits: dsql<string>`COALESCE(SUM(CASE WHEN ${cashDrawerEntries.kind} = 'DEPOSIT' THEN ${cashDrawerEntries.amountCents} ELSE 0 END), 0)`,
      withdrawals: dsql<string>`COALESCE(SUM(CASE WHEN ${cashDrawerEntries.kind} = 'WITHDRAWAL' THEN ${cashDrawerEntries.amountCents} ELSE 0 END), 0)`,
      n: dsql<string>`COUNT(*)`,
    })
    .from(cashDrawerEntries)
    .where(and(eq(cashDrawerEntries.businessId, businessId), isNull(cashDrawerEntries.voidedAt)));
  const deposits = Number(row?.deposits ?? 0);
  const withdrawals = Number(row?.withdrawals ?? 0);
  return { onHandCents: deposits - withdrawals, depositsCents: deposits, withdrawalsCents: withdrawals, entryCount: Number(row?.n ?? 0) };
}

// ── Businesses ────────────────────────────────────────────────────────────────

router.get('/businesses', asyncHandler(async (_req, res) => {
  const list = await db.query.cashBusinesses.findMany({
    where: isNull(cashBusinesses.archivedAt),
    orderBy: [desc(cashBusinesses.payrollLinked), cashBusinesses.name],
  });
  const businesses = await Promise.all(list.map(async (b) => {
    if (b.payrollLinked) {
      if (!isPayrollDrawerEnabled()) {
        return { ...b, available: false, onHandCents: 0, depositsCents: 0, withdrawalsCents: 0, entryCount: 0 };
      }
      const totals = await getPayrollDrawerTotals();
      return { ...b, available: true, ...totals };
    }
    const totals = await localTotals(b.id);
    return { ...b, available: true, ...totals };
  }));
  res.json({ businesses, payrollAppUrl: payrollAppUrl() });
}));

const createBusinessSchema = z.object({ name: z.string().trim().min(1).max(120) });

router.post('/businesses', asyncHandler(async (req, res) => {
  const body = createBusinessSchema.parse(req.body);
  const existing = await db.query.cashBusinesses.findFirst({ where: eq(cashBusinesses.name, body.name) });
  if (existing) throw createError('A business with that name already exists.', 409, 'DUPLICATE_NAME');
  const [biz] = await db.insert(cashBusinesses).values({ name: body.name }).returning();
  await auditLog({ entityType: 'cash_business', entityId: biz.id, userId: req.user!.id, action: 'cashbook.business.created', after: { name: biz.name } });
  res.status(201).json({ business: biz });
}));

// ── Ledger ────────────────────────────────────────────────────────────────────

router.get('/businesses/:id/ledger', asyncHandler(async (req, res) => {
  const biz = await getBusiness(req.params.id);
  if (biz.payrollLinked) {
    const entries = await listPayrollEntries();
    res.json({
      entries: entries.map((e) => ({ ...e, entryDate: null, periodLinked: Boolean(e.periodId) })),
      payrollLinked: true,
      payrollAppUrl: payrollAppUrl(),
    });
    return;
  }
  const rows = await db.query.cashDrawerEntries.findMany({
    where: and(eq(cashDrawerEntries.businessId, biz.id), isNull(cashDrawerEntries.voidedAt)),
    with: { createdBy: { columns: { id: true, name: true, email: true } } },
    orderBy: [desc(cashDrawerEntries.createdAt)],
    limit: 500,
  });
  res.json({
    entries: rows.map((e) => ({
      id: e.id,
      kind: e.kind,
      amountCents: e.amountCents,
      invoiceNumber: e.invoiceNumber,
      notes: e.notes,
      category: e.category,
      receiptPath: e.receiptPath ? true : null, // presence only; file streams via /receipts
      periodId: null,
      periodStart: null,
      periodEnd: null,
      periodLinked: false,
      entryDate: e.entryDate,
      createdByLabel: e.createdBy?.name ?? e.createdByLabel,
      createdAt: e.createdAt,
    })),
    payrollLinked: false,
    payrollAppUrl: null,
  });
}));

// ── Recording entries ─────────────────────────────────────────────────────────

const depositSchema = z.object({
  amount: z.union([z.string(), z.number()]),
  invoiceNumber: z.string().trim().min(1),
  notes: z.string().trim().max(2000).optional(),
  entryDate: z.string().optional(),
});

router.post('/businesses/:id/deposit', asyncHandler(async (req, res) => {
  const biz = await getBusiness(req.params.id);
  const body = depositSchema.parse(req.body);
  const amountCents = toCents(body.amount);
  const invalid = validateDeposit({ amountCents, invoiceNumber: body.invoiceNumber });
  if (invalid) throw createError(invalid, 400, 'INVALID_ENTRY');

  if (biz.payrollLinked) {
    const row = await recordPayrollDeposit({ amountCents, invoiceNumber: body.invoiceNumber, notes: body.notes }, actor(req));
    res.status(201).json({ id: row.id });
    return;
  }

  const entryDate = body.entryDate ?? localTodayIso();
  const dateInvalid = validateEntryDate(entryDate);
  if (dateInvalid) throw createError(dateInvalid, 400, 'INVALID_ENTRY');
  const [row] = await db.insert(cashDrawerEntries).values({
    businessId: biz.id,
    kind: 'DEPOSIT',
    amountCents,
    invoiceNumber: body.invoiceNumber.trim(),
    notes: body.notes || null,
    entryDate,
    createdById: req.user!.id,
  }).returning();
  await auditLog({ entityType: 'cash_drawer_entry', entityId: row.id, userId: req.user!.id, action: 'cashbook.deposit', after: { businessId: biz.id, amountCents, invoiceNumber: body.invoiceNumber.trim() } });
  res.status(201).json({ id: row.id });
}));

const withdrawalSchema = z.object({
  amount: z.union([z.string(), z.number()]),
  notes: z.string().trim().max(2000).optional(),
  entryDate: z.string().optional(),
});

/** Withdrawal + balance guard in one transaction, serialized per business. */
async function recordLocalWithdrawal(
  biz: { id: string },
  input: { amountCents: number; notes: string | null; category: string | null; receiptPath: string | null; entryDate: string },
  userId: string,
): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    // Per-business advisory lock so concurrent withdrawals can't jointly overdraft.
    await tx.execute(dsql`SELECT pg_advisory_xact_lock(hashtext(${'cash-' + biz.id}))`);
    const [row] = await tx
      .select({
        deposits: dsql<string>`COALESCE(SUM(CASE WHEN ${cashDrawerEntries.kind} = 'DEPOSIT' THEN ${cashDrawerEntries.amountCents} ELSE 0 END), 0)`,
        withdrawals: dsql<string>`COALESCE(SUM(CASE WHEN ${cashDrawerEntries.kind} = 'WITHDRAWAL' THEN ${cashDrawerEntries.amountCents} ELSE 0 END), 0)`,
      })
      .from(cashDrawerEntries)
      .where(and(eq(cashDrawerEntries.businessId, biz.id), isNull(cashDrawerEntries.voidedAt)));
    const balance = Number(row?.deposits ?? 0) - Number(row?.withdrawals ?? 0);
    if (balance - input.amountCents < 0) {
      throw createError(
        `Insufficient cash on hand. Drawer balance is $${(balance / 100).toFixed(2)}; tried to withdraw $${(input.amountCents / 100).toFixed(2)}.`,
        409,
        'INSUFFICIENT_CASH',
      );
    }
    const [entry] = await tx.insert(cashDrawerEntries).values({
      businessId: biz.id,
      kind: 'WITHDRAWAL',
      amountCents: input.amountCents,
      notes: input.notes,
      category: input.category,
      receiptPath: input.receiptPath,
      entryDate: input.entryDate,
      createdById: userId,
    }).returning();
    return entry;
  });
}

router.post('/businesses/:id/withdrawal', asyncHandler(async (req, res) => {
  const biz = await getBusiness(req.params.id);
  const body = withdrawalSchema.parse(req.body);
  const amountCents = toCents(body.amount);
  const invalid = validateAmountCents(amountCents);
  if (invalid) throw createError(invalid, 400, 'INVALID_ENTRY');

  if (biz.payrollLinked) {
    const row = await recordPayrollWithdrawal({ amountCents, notes: body.notes }, actor(req));
    res.status(201).json({ id: row.id });
    return;
  }

  const entryDate = body.entryDate ?? localTodayIso();
  const dateInvalid = validateEntryDate(entryDate);
  if (dateInvalid) throw createError(dateInvalid, 400, 'INVALID_ENTRY');
  const row = await recordLocalWithdrawal(biz, { amountCents, notes: body.notes || null, category: null, receiptPath: null, entryDate }, req.user!.id);
  await auditLog({ entityType: 'cash_drawer_entry', entityId: row.id, userId: req.user!.id, action: 'cashbook.withdraw', after: { businessId: biz.id, amountCents } });
  res.status(201).json({ id: row.id });
}));

const pettyCashSchema = z.object({
  amount: z.union([z.string(), z.number()]),
  description: z.string().trim().min(1).max(500),
  reference: z.string().trim().max(120).optional(),
  entryDate: z.string().optional(),
});

router.post('/businesses/:id/petty-cash', upload.single('receipt'), asyncHandler(async (req, res) => {
  const biz = await getBusiness(req.params.id);
  const body = pettyCashSchema.parse(req.body);
  const amountCents = toCents(body.amount);
  const invalid = validatePettyCash({ amountCents, description: body.description });
  if (invalid) throw createError(invalid, 400, 'INVALID_ENTRY');

  let receiptPath: string | null = null;
  if (req.file) {
    const stored = await storage.save(req.file.buffer, req.file.originalname, req.file.mimetype);
    receiptPath = stored.storagePath;
  }

  if (biz.payrollLinked) {
    const row = await recordPayrollPettyCash(
      { amountCents, description: body.description, reference: body.reference, receiptPath },
      actor(req),
    );
    res.status(201).json({ id: row.id });
    return;
  }

  const entryDate = body.entryDate ?? localTodayIso();
  const dateInvalid = validateEntryDate(entryDate);
  if (dateInvalid) throw createError(dateInvalid, 400, 'INVALID_ENTRY');
  const row = await recordLocalWithdrawal(
    biz,
    {
      amountCents,
      notes: pettyCashNote(body.description, body.reference),
      category: PETTY_CASH_CATEGORY,
      receiptPath,
      entryDate,
    },
    req.user!.id,
  );
  await auditLog({ entityType: 'cash_drawer_entry', entityId: row.id, userId: req.user!.id, action: 'cashbook.petty_cash', after: { businessId: biz.id, amountCents, description: body.description } });
  res.status(201).json({ id: row.id });
}));

// ── Void ──────────────────────────────────────────────────────────────────────

router.post('/businesses/:id/entries/:entryId/void', asyncHandler(async (req, res) => {
  const biz = await getBusiness(req.params.id);

  if (biz.payrollLinked) {
    await voidPayrollEntry(req.params.entryId, actor(req));
    res.json({ ok: true });
    return;
  }

  await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT pg_advisory_xact_lock(hashtext(${'cash-' + biz.id}))`);
    const entry = await tx.query.cashDrawerEntries.findFirst({
      where: and(eq(cashDrawerEntries.id, req.params.entryId), eq(cashDrawerEntries.businessId, biz.id)),
    });
    if (!entry) throw notFound('Ledger entry not found');
    if (entry.voidedAt) throw createError('Entry is already voided.', 409, 'ALREADY_VOIDED');
    if (entry.kind === 'DEPOSIT') {
      const totals = await localTotals(biz.id);
      if (totals.onHandCents - entry.amountCents < 0) {
        throw createError('Voiding this deposit would drop the drawer below zero.', 409, 'INSUFFICIENT_CASH');
      }
    }
    await tx.update(cashDrawerEntries)
      .set({ voidedAt: new Date(), voidedById: req.user!.id })
      .where(eq(cashDrawerEntries.id, entry.id));
  });
  await auditLog({ entityType: 'cash_drawer_entry', entityId: req.params.entryId, userId: req.user!.id, action: 'cashbook.void', after: { businessId: biz.id } });
  res.json({ ok: true });
}));

// ── Receipts & export ─────────────────────────────────────────────────────────

function resolveUploadPath(storagePath: string): string | null {
  const base = path.resolve(env.UPLOADS_DIR);
  const full = path.resolve(base, storagePath);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

router.get('/businesses/:id/entries/:entryId/receipt', asyncHandler(async (req, res: Response) => {
  const biz = await getBusiness(req.params.id);
  if (biz.payrollLinked) throw notFound('Receipt not found'); // payroll-side receipts live in the payroll app
  const entry = await db.query.cashDrawerEntries.findFirst({
    where: and(eq(cashDrawerEntries.id, req.params.entryId), eq(cashDrawerEntries.businessId, biz.id)),
  });
  if (!entry?.receiptPath) throw notFound('Receipt not found');
  const fullPath = resolveUploadPath(entry.receiptPath);
  if (!fullPath) throw notFound('Receipt not found');
  try {
    await fsp.access(fullPath);
  } catch {
    throw notFound('Receipt not found');
  }
  const ext = path.extname(fullPath).toLowerCase();
  const mime = ext === '.pdf' ? 'application/pdf' : ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `inline; filename="${path.basename(fullPath).replace(/"/g, '')}"`);
  fs.createReadStream(fullPath).pipe(res);
}));

router.get('/businesses/:id/export.csv', asyncHandler(async (req, res) => {
  const biz = await getBusiness(req.params.id);
  let entries: CsvEntry[];
  if (biz.payrollLinked) {
    entries = (await listPayrollEntries()).map((e) => ({
      createdAt: e.createdAt,
      entryDate: null,
      kind: e.kind,
      category: e.category,
      amountCents: e.amountCents,
      invoiceNumber: e.invoiceNumber,
      notes: e.notes,
      createdByLabel: e.createdByLabel,
    }));
  } else {
    const rows = await db.query.cashDrawerEntries.findMany({
      where: and(eq(cashDrawerEntries.businessId, biz.id), isNull(cashDrawerEntries.voidedAt)),
      with: { createdBy: { columns: { name: true } } },
      orderBy: [desc(cashDrawerEntries.createdAt)],
    });
    entries = rows.map((e) => ({
      createdAt: e.createdAt,
      entryDate: e.entryDate,
      kind: e.kind,
      category: e.category,
      amountCents: e.amountCents,
      invoiceNumber: e.invoiceNumber,
      notes: e.notes,
      createdByLabel: e.createdBy?.name ?? e.createdByLabel,
    }));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="cashbook-${biz.name.replace(/[^\w-]+/g, '_')}.csv"`);
  res.send(buildLedgerCsv(entries));
}));

export default router;
