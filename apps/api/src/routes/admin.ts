import { Router } from 'express';
import { z } from 'zod';
import { and, count, desc, eq, gte, ilike, inArray, isNotNull, lte, or } from 'drizzle-orm';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { db } from '../db/index';
import {
  users, expenseCategories, categoryZohoAccounts, appConnections, ssoLinks,
  expenses, expenseMessages, captures, partnerExpenses, companies,
  paymentMethods, auditLogs,
} from '../db/schema';
import { env } from '../config/env';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler, notFound, createError } from '../middleware/error';
import { auditLog } from '../lib/audit';
import { storage } from '../lib/storage';
import { canDeleteUser, canChangeRole, hasOwnedData, type OwnedCounts } from '../lib/userDelete';
import { issueInvite } from '../lib/invites';
import { parseAuditFilters } from '../lib/auditFilters';
import { wouldCreateCycle } from '../lib/categoryTree';

const router = Router();
router.use(authenticate);

// Route-level gates. Categories are shared with accountants; everything else
// stays admin-only. Developer passes every gate automatically (see roleAllowed).
const adminOnly = requireRole('admin');
const accounting = requireRole('accountant', 'admin');

async function countActiveAdmins(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(users)
    .where(and(eq(users.role, 'admin'), eq(users.isActive, true)));
  return Number(row?.n ?? 0);
}

// ── Companies ───────────────────────────────────────────────────────────────

const companySchema = z.object({
  name: z.string().min(1).max(120),
  zohoEnabled: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

router.get('/companies', adminOnly, asyncHandler(async (_req, res) => {
  const rows = await db.query.companies.findMany({
    orderBy: (c, { asc }) => [asc(c.sortOrder), asc(c.name)],
  });
  res.json({ companies: rows });
}));

router.post('/companies', adminOnly, asyncHandler(async (req, res) => {
  const body = companySchema.parse(req.body);
  const existing = await db.query.companies.findFirst({ where: eq(companies.name, body.name) });
  if (existing) throw createError('Company name already exists', 409, 'CONFLICT');

  const [company] = await db.insert(companies).values(body).returning();
  await auditLog({
    entityType: 'company',
    entityId: company.id,
    userId: req.user!.id,
    action: 'admin.company.created',
    after: company,
  });
  res.status(201).json({ company });
}));

router.patch('/companies/:id', adminOnly, asyncHandler(async (req, res) => {
  const body = companySchema.partial().parse(req.body);
  const target = await db.query.companies.findFirst({ where: eq(companies.id, req.params.id) });
  if (!target) throw notFound('Company not found');

  const [updated] = await db.update(companies)
    .set(body)
    .where(eq(companies.id, req.params.id))
    .returning();

  await auditLog({
    entityType: 'company',
    entityId: target.id,
    userId: req.user!.id,
    action: 'admin.company.updated',
    before: target,
    after: updated,
  });
  res.json({ company: updated });
}));

// ── Users ──────────────────────────────────────────────────────────────────

router.get('/users', adminOnly, asyncHandler(async (_req, res) => {
  const rows = await db.query.users.findMany({
    // Never return the hash or the raw invite token (the invite URL is shown
    // once at issue time; leaking the token here would let any admin session
    // hijack a pending invite silently).
    columns: { passwordHash: false, inviteToken: false },
    orderBy: (u, { asc }) => [asc(u.name)],
  });
  // Derive a SAFE auth-source signal (booleans only) so the UI can show an
  // "SSO-only / Local / SSO + Local" badge. The password hash itself and the SSO
  // subject IDs are never returned.
  const pwRows = await db.select({ id: users.id }).from(users).where(isNotNull(users.passwordHash));
  const ssoRows = await db.selectDistinct({ userId: ssoLinks.userId }).from(ssoLinks);
  const hasPwSet = new Set(pwRows.map((r) => r.id));
  const hasSsoSet = new Set(ssoRows.map((r) => r.userId));
  const out = rows.map((u) => ({
    ...u,
    hasPassword: hasPwSet.has(u.id),
    hasSso: hasSsoSet.has(u.id),
  }));
  res.json({ users: out });
}));

const createUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  role: z.enum(['user', 'accountant', 'admin', 'partner', 'developer']),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

router.post('/users', adminOnly, asyncHandler(async (req, res) => {
  const { name, email, role, password } = createUserSchema.parse(req.body);

  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (existing) throw createError('Email already in use', 409, 'CONFLICT');

  const passwordHash = await bcrypt.hash(password, 12);
  const [user] = await db.insert(users)
    .values({ name, email, role, passwordHash })
    .returning({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      isActive: users.isActive,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    });

  await auditLog({
    entityType: 'user',
    entityId: user.id,
    userId: req.user!.id,
    action: 'admin.user.created',
    after: { email, name, role },
  });

  res.status(201).json({ user });
}));

const profileFieldsSchema = z.object({
  department: z.string().max(120).nullable().optional(),
  employeeId: z.string().max(60).nullable().optional(),
  costCenter: z.string().max(60).nullable().optional(),
  managerId: z.string().uuid().nullable().optional(),
  defaultZohoEntity: z.string().max(200).nullable().optional(),
  defaultPaymentMethodId: z.string().uuid().nullable().optional(),
});

const PROFILE_FIELDS = [
  'department', 'employeeId', 'costCenter', 'managerId', 'defaultZohoEntity', 'defaultPaymentMethodId',
] as const;

const patchUserSchema = profileFieldsSchema.extend({
  name: z.string().min(1).max(100).optional(),
  role: z.enum(['user', 'accountant', 'admin', 'partner', 'developer']).optional(),
  isActive: z.boolean().optional(),
});

const userReturningColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  isActive: users.isActive,
  department: users.department,
  employeeId: users.employeeId,
  costCenter: users.costCenter,
  managerId: users.managerId,
  defaultZohoEntity: users.defaultZohoEntity,
  defaultPaymentMethodId: users.defaultPaymentMethodId,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
} as const;

/** Validates manager / default payment method references on user writes. */
async function validateProfileRefs(body: { managerId?: string | null; defaultPaymentMethodId?: string | null }, selfId?: string) {
  if (body.managerId) {
    if (selfId && body.managerId === selfId) {
      throw createError('A user cannot be their own manager', 400, 'SELF_MANAGER');
    }
    const mgr = await db.query.users.findFirst({ where: eq(users.id, body.managerId), columns: { id: true } });
    if (!mgr) throw createError('Manager not found', 400, 'MANAGER_NOT_FOUND');
  }
  if (body.defaultPaymentMethodId) {
    const pm = await db.query.paymentMethods.findFirst({
      where: eq(paymentMethods.id, body.defaultPaymentMethodId), columns: { id: true },
    });
    if (!pm) throw createError('Payment method not found', 400, 'PAYMENT_METHOD_NOT_FOUND');
  }
}

router.patch('/users/:id', adminOnly, asyncHandler(async (req, res) => {
  const body = patchUserSchema.parse(req.body);

  const target = await db.query.users.findFirst({ where: eq(users.id, req.params.id) });
  if (!target) throw notFound('User not found');

  if ('isActive' in body && body.isActive === false && req.params.id === req.user!.id) {
    throw createError('You cannot deactivate your own account', 400, 'SELF_DEACTIVATION');
  }

  if (body.role !== undefined && body.role !== target.role) {
    const decision = canChangeRole({
      actorId: req.user!.id,
      targetId: target.id,
      targetRole: target.role,
      newRole: body.role,
      targetIsActive: target.isActive,
      activeAdminCount: await countActiveAdmins(),
    });
    if (!decision.ok) throw createError(decision.message, decision.status, decision.code);
  }

  await validateProfileRefs(body, target.id);

  const [updated] = await db.update(users)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(users.id, req.params.id))
    .returning(userReturningColumns);

  const changedProfileFields = PROFILE_FIELDS.filter(
    (k) => k in body && (body as Record<string, unknown>)[k] !== (target as Record<string, unknown>)[k],
  );

  if ('isActive' in body) {
    await auditLog({
      entityType: 'user',
      entityId: target.id,
      userId: req.user!.id,
      action: body.isActive ? 'admin.user.reactivated' : 'admin.user.deactivated',
      before: { isActive: target.isActive },
      after: { isActive: body.isActive },
    });
  } else if (body.name !== undefined || body.role !== undefined || changedProfileFields.length > 0) {
    const pick = (src: Record<string, unknown>) =>
      Object.fromEntries(changedProfileFields.map((k) => [k, src[k] ?? null]));
    await auditLog({
      entityType: 'user',
      entityId: target.id,
      userId: req.user!.id,
      action: 'admin.user.updated',
      before: { name: target.name, role: target.role, ...pick(target as Record<string, unknown>) },
      after: { name: updated.name, role: updated.role, ...pick(updated as Record<string, unknown>) },
    });
  }

  res.json({ user: updated });
}));

// Hard delete. Default: only succeeds when the user owns no data (409 HAS_DATA
// with counts otherwise). ?purge=true also removes everything they own, unless
// any of their expenses is synced to Zoho (409 ZOHO_LINKED).
router.delete('/users/:id', adminOnly, asyncHandler(async (req, res) => {
  const purge = req.query.purge === 'true';

  const target = await db.query.users.findFirst({ where: eq(users.id, req.params.id) });
  if (!target) throw notFound('User not found');

  const decision = canDeleteUser({
    actorId: req.user!.id,
    targetId: target.id,
    targetRole: target.role,
    targetIsActive: target.isActive,
    activeAdminCount: await countActiveAdmins(),
  });
  if (!decision.ok) throw createError(decision.message, decision.status, decision.code);

  const owned = await db.query.expenses.findMany({
    where: eq(expenses.userId, target.id),
    columns: { id: true, zohoExpenseId: true },
    with: { receipts: { columns: { id: true, storagePath: true } } },
  });
  const [msgRow] = await db.select({ n: count() }).from(expenseMessages)
    .where(eq(expenseMessages.senderId, target.id));
  const [capRow] = await db.select({ n: count() }).from(captures)
    .where(eq(captures.userId, target.id));
  const [peRow] = await db.select({ n: count() }).from(partnerExpenses)
    .where(eq(partnerExpenses.userId, target.id));

  const counts: OwnedCounts = {
    expenses: owned.length,
    receipts: owned.reduce((n, e) => n + e.receipts.length, 0),
    messages: Number(msgRow?.n ?? 0),
    captures: Number(capRow?.n ?? 0),
    partnerExpenses: Number(peRow?.n ?? 0),
  };

  if (hasOwnedData(counts) && !purge) {
    throw createError('User owns data. Use purge to delete the user and all their data.', 409, 'HAS_DATA', { counts });
  }

  if (purge) {
    const zohoLinked = owned.filter((e) => e.zohoExpenseId).length;
    if (zohoLinked > 0) {
      throw createError(
        `${zohoLinked} expense(s) are synced to Zoho. Delete or unlink those expenses first.`,
        409, 'ZOHO_LINKED',
      );
    }
    for (const e of owned) {
      for (const r of e.receipts) await storage.delete(r.storagePath);
    }
    if (owned.length > 0) {
      await db.delete(expenses).where(inArray(expenses.id, owned.map((e) => e.id)));
    }
    await db.delete(expenseMessages).where(eq(expenseMessages.senderId, target.id));
    await db.delete(captures).where(eq(captures.userId, target.id));
    await db.delete(partnerExpenses).where(eq(partnerExpenses.userId, target.id));
  }

  await db.delete(users).where(eq(users.id, target.id));

  await auditLog({
    entityType: 'user',
    entityId: target.id,
    userId: req.user!.id,
    action: purge ? 'admin.user.purged' : 'admin.user.deleted',
    before: { email: target.email, name: target.name, role: target.role },
    metadata: { counts },
  });

  res.json({ ok: true, purged: purge });
}));

router.post('/users/:id/reset-password', adminOnly, asyncHandler(async (req, res) => {
  const target = await db.query.users.findFirst({ where: eq(users.id, req.params.id) });
  if (!target) throw notFound('User not found');

  const tempPassword = crypto.randomBytes(12).toString('base64url').slice(0, 16);
  const passwordHash = await bcrypt.hash(tempPassword, 12);

  await db.update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.id, req.params.id));

  await auditLog({
    entityType: 'user',
    entityId: target.id,
    userId: req.user!.id,
    action: 'admin.user.password_reset',
    metadata: { resetBy: req.user!.email, targetEmail: target.email },
  });

  res.json({
    ok: true,
    tempPassword,
    warning: 'This temporary password is shown only once. Share it securely with the user.',
  });
}));

// ── Invitations ────────────────────────────────────────────────────────────
// Email delivery lands with sub-project F — for now the returned inviteUrl is
// shown once in the admin UI and shared out-of-band.

function inviteUrlFor(token: string): string {
  const webBase = (env.MIDAS_WEB_BASE_URL ?? env.CORS_ORIGIN).replace(/\/$/, '');
  return `${webBase}/invite/${token}`;
}

const inviteUserSchema = profileFieldsSchema.extend({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  role: z.enum(['user', 'accountant', 'admin', 'partner', 'developer']),
});

router.post('/users/invite', adminOnly, asyncHandler(async (req, res) => {
  const body = inviteUserSchema.parse(req.body);

  const existing = await db.query.users.findFirst({ where: eq(users.email, body.email) });
  if (existing) throw createError('Email already in use', 409, 'CONFLICT');

  await validateProfileRefs(body);

  const { token, expiresAt } = issueInvite(new Date());
  const [user] = await db.insert(users)
    .values({ ...body, passwordHash: null, isActive: true, inviteToken: token, inviteExpiresAt: expiresAt })
    .returning(userReturningColumns);

  await auditLog({
    entityType: 'user',
    entityId: user.id,
    userId: req.user!.id,
    action: 'admin.user.invited',
    after: { email: body.email, name: body.name, role: body.role },
    metadata: { inviteExpiresAt: expiresAt.toISOString() },
  });

  res.status(201).json({ user, inviteUrl: inviteUrlFor(token) });
}));

router.post('/users/:id/invite/resend', adminOnly, asyncHandler(async (req, res) => {
  const target = await db.query.users.findFirst({ where: eq(users.id, req.params.id) });
  if (!target) throw notFound('User not found');

  if (target.passwordHash) {
    throw createError('User already has a password — invites only apply before first login', 409, 'HAS_PASSWORD');
  }
  const ssoLink = await db.query.ssoLinks.findFirst({
    where: eq(ssoLinks.userId, target.id), columns: { id: true },
  });
  if (ssoLink) {
    throw createError('User signs in via SSO — an invite is not applicable', 409, 'SSO_LINKED');
  }

  const { token, expiresAt } = issueInvite(new Date());
  await db.update(users)
    .set({ inviteToken: token, inviteExpiresAt: expiresAt, updatedAt: new Date() })
    .where(eq(users.id, target.id));

  await auditLog({
    entityType: 'user',
    entityId: target.id,
    userId: req.user!.id,
    action: 'admin.user.invite_resent',
    metadata: { targetEmail: target.email, inviteExpiresAt: expiresAt.toISOString() },
  });

  res.json({ inviteUrl: inviteUrlFor(token), expiresAt });
}));

// ── Bulk user operations ───────────────────────────────────────────────────
// Deactivate/reactivate only — bulk delete is intentionally NOT offered.

const bulkUsersSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  action: z.enum(['deactivate', 'reactivate']),
});

router.post('/users/bulk', adminOnly, asyncHandler(async (req, res) => {
  const { ids, action } = bulkUsersSchema.parse(req.body);
  const wantActive = action === 'reactivate';

  const rows = await db.select({ id: users.id, role: users.role, isActive: users.isActive })
    .from(users).where(inArray(users.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));

  let activeAdmins = await countActiveAdmins();
  const updated: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const id of new Set(ids)) {
    const row = byId.get(id);
    if (!row) { skipped.push({ id, reason: 'not_found' }); continue; }
    if (id === req.user!.id) { skipped.push({ id, reason: 'self' }); continue; }
    if (row.isActive === wantActive) {
      skipped.push({ id, reason: wantActive ? 'already_active' : 'already_inactive' });
      continue;
    }
    if (!wantActive && row.role === 'admin' && row.isActive && activeAdmins <= 1) {
      skipped.push({ id, reason: 'last_admin' });
      continue;
    }
    if (row.role === 'admin') activeAdmins += wantActive ? 1 : -1;
    updated.push(id);
  }

  if (updated.length > 0) {
    await db.update(users)
      .set({ isActive: wantActive, updatedAt: new Date() })
      .where(inArray(users.id, updated));
  }

  await auditLog({
    entityType: 'user',
    entityId: 'bulk',
    userId: req.user!.id,
    action: wantActive ? 'admin.user.bulk_reactivated' : 'admin.user.bulk_deactivated',
    metadata: { requested: ids.length, updated, skipped },
  });

  res.json({ updated, skipped });
}));

// ── Audit log ──────────────────────────────────────────────────────────────

router.get('/audit', adminOnly, asyncHandler(async (req, res) => {
  const f = parseAuditFilters(req.query as Record<string, string | undefined>);

  const conds = [];
  if (f.entityType) conds.push(eq(auditLogs.entityType, f.entityType));
  if (f.action) conds.push(ilike(auditLogs.action, `${f.action}%`));
  if (f.userId) conds.push(eq(auditLogs.userId, f.userId));
  if (f.entityId) conds.push(eq(auditLogs.entityId, f.entityId));
  if (f.from) conds.push(gte(auditLogs.createdAt, new Date(`${f.from}T00:00:00.000`)));
  if (f.to) conds.push(lte(auditLogs.createdAt, new Date(`${f.to}T23:59:59.999`)));
  if (f.search) {
    conds.push(or(
      ilike(auditLogs.action, `%${f.search}%`),
      ilike(auditLogs.entityType, `%${f.search}%`),
    )!);
  }
  const where = conds.length > 0 ? and(...conds) : undefined;

  const [totalRow] = await db.select({ n: count() }).from(auditLogs).where(where);
  const entries = await db.select({
    id: auditLogs.id,
    entityType: auditLogs.entityType,
    entityId: auditLogs.entityId,
    action: auditLogs.action,
    before: auditLogs.before,
    after: auditLogs.after,
    metadata: auditLogs.metadata,
    createdAt: auditLogs.createdAt,
    actorId: auditLogs.userId,
    actorName: users.name,
  })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .where(where)
    .orderBy(desc(auditLogs.createdAt))
    .limit(f.pageSize)
    .offset((f.page - 1) * f.pageSize);

  res.json({ entries, total: Number(totalRow?.n ?? 0), page: f.page, pageSize: f.pageSize });
}));

// ── Categories ─────────────────────────────────────────────────────────────

router.get('/categories', accounting, asyncHandler(async (_req, res) => {
  const cats = await db.query.expenseCategories.findMany({
    orderBy: (c, { asc }) => [asc(c.name)],
  });
  res.json({ categories: cats });
}));

router.post('/categories', accounting, asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parentId: z.string().uuid().nullable().optional(),
  }).parse(req.body);

  const [cat] = await db.insert(expenseCategories).values(body).returning();
  res.status(201).json({ category: cat });
}));

router.patch('/categories/:id', accounting, asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    isActive: z.boolean().optional(),
    parentId: z.string().uuid().nullable().optional(),
  }).parse(req.body);

  if (body.parentId !== undefined) {
    const all = await db.query.expenseCategories.findMany();
    if (wouldCreateCycle(all, req.params.id, body.parentId)) {
      throw createError('That parent would create a cycle in the category tree', 400, 'CATEGORY_CYCLE');
    }
  }

  const [updated] = await db.update(expenseCategories)
    .set(body)
    .where(eq(expenseCategories.id, req.params.id))
    .returning();

  res.json({ category: updated });
}));

// ── Chart of Accounts (category → Zoho COA account, per company) ───────────
// Zoho account ids differ per sister company, so mappings are keyed by
// (category, company). Categories without their own mapping inherit from the
// nearest mapped ancestor at push time (see lib/categoryZohoAccounts.ts).

router.get('/category-zoho-accounts', accounting, asyncHandler(async (req, res) => {
  const companyName = typeof req.query.companyName === 'string' ? req.query.companyName.trim() : '';
  if (!companyName) throw createError('companyName is required', 400, 'MISSING_COMPANY');

  const mappings = await db.select({
    categoryId: categoryZohoAccounts.categoryId,
    companyName: categoryZohoAccounts.companyName,
    zohoAccountId: categoryZohoAccounts.zohoAccountId,
  }).from(categoryZohoAccounts).where(eq(categoryZohoAccounts.companyName, companyName));

  res.json({ mappings });
}));

router.put('/category-zoho-accounts', accounting, asyncHandler(async (req, res) => {
  const body = z.object({
    categoryId: z.string().uuid(),
    companyName: z.string().min(1),
    zohoAccountId: z.string().min(1),
  }).parse(req.body);

  const category = await db.query.expenseCategories.findFirst({
    where: eq(expenseCategories.id, body.categoryId),
  });
  if (!category) throw notFound('Category not found');
  const company = await db.query.companies.findFirst({ where: eq(companies.name, body.companyName) });
  if (!company) throw notFound('Company not found');

  const [mapping] = await db.insert(categoryZohoAccounts)
    .values(body)
    .onConflictDoUpdate({
      target: [categoryZohoAccounts.categoryId, categoryZohoAccounts.companyName],
      set: { zohoAccountId: body.zohoAccountId },
    })
    .returning();

  await auditLog({
    entityType: 'category_zoho_account',
    entityId: mapping.id,
    userId: req.user!.id,
    action: 'admin.coa.mapped',
    after: mapping,
    metadata: { categoryName: category.name },
  });
  res.json({ mapping });
}));

router.delete('/category-zoho-accounts', accounting, asyncHandler(async (req, res) => {
  const categoryId = typeof req.query.categoryId === 'string' ? req.query.categoryId : '';
  const companyName = typeof req.query.companyName === 'string' ? req.query.companyName.trim() : '';
  if (!categoryId || !companyName) throw createError('categoryId and companyName are required', 400, 'MISSING_PARAMS');

  const [removed] = await db.delete(categoryZohoAccounts)
    .where(and(
      eq(categoryZohoAccounts.categoryId, categoryId),
      eq(categoryZohoAccounts.companyName, companyName),
    ))
    .returning();
  if (!removed) throw notFound('Mapping not found');

  await auditLog({
    entityType: 'category_zoho_account',
    entityId: removed.id,
    userId: req.user!.id,
    action: 'admin.coa.unmapped',
    before: removed,
  });
  res.json({ ok: true });
}));

// ── App Connections (app-to-app API keys) ──────────────────────────────────

router.get('/connections', adminOnly, asyncHandler(async (_req, res) => {
  const conns = await db.query.appConnections.findMany({
    columns: { apiKeyHash: false },
    orderBy: (c, { asc }) => [asc(c.appName)],
  });
  res.json({ connections: conns });
}));

router.post('/connections', adminOnly, asyncHandler(async (req, res) => {
  const { appName, permissions } = z.object({
    appName: z.string().min(1),
    permissions: z.array(z.string()).default([]),
  }).parse(req.body);

  const apiKey = `midas_${crypto.randomBytes(32).toString('hex')}`;
  const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

  const [conn] = await db.insert(appConnections).values({
    appName,
    apiKeyHash,
    permissions,
  }).returning({ id: appConnections.id, appName: appConnections.appName, permissions: appConnections.permissions, createdAt: appConnections.createdAt });

  res.status(201).json({ connection: conn, apiKey });
}));

router.patch('/connections/:id', adminOnly, asyncHandler(async (req, res) => {
  const body = z.object({
    isActive: z.boolean().optional(),
    permissions: z.array(z.string()).optional(),
  }).parse(req.body);
  if (body.isActive === undefined && body.permissions === undefined) {
    throw createError('Provide isActive and/or permissions', 400, 'VALIDATION_ERROR');
  }
  const [updated] = await db.update(appConnections)
    .set({
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      ...(body.permissions !== undefined ? { permissions: body.permissions } : {}),
    })
    .where(eq(appConnections.id, req.params.id))
    .returning({
      id: appConnections.id,
      appName: appConnections.appName,
      isActive: appConnections.isActive,
      permissions: appConnections.permissions,
    });
  if (!updated) throw notFound('Connection not found');
  res.json({ connection: updated });
}));

export default router;
