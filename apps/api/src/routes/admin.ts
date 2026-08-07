import { Router } from 'express';
import { z } from 'zod';
import { and, count, eq, inArray, isNotNull } from 'drizzle-orm';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { db } from '../db/index';
import {
  users, expenseCategories, appConnections, ssoLinks,
  expenses, expenseMessages, captures, partnerExpenses, companies,
} from '../db/schema';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler, notFound, createError } from '../middleware/error';
import { auditLog } from '../lib/audit';
import { storage } from '../lib/storage';
import { canDeleteUser, canChangeRole, hasOwnedData, type OwnedCounts } from '../lib/userDelete';

const router = Router();
router.use(authenticate, requireRole('admin'));

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

router.get('/companies', asyncHandler(async (_req, res) => {
  const rows = await db.query.companies.findMany({
    orderBy: (c, { asc }) => [asc(c.sortOrder), asc(c.name)],
  });
  res.json({ companies: rows });
}));

router.post('/companies', asyncHandler(async (req, res) => {
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

router.patch('/companies/:id', asyncHandler(async (req, res) => {
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

router.get('/users', asyncHandler(async (_req, res) => {
  const rows = await db.query.users.findMany({
    columns: { passwordHash: false },
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

router.post('/users', asyncHandler(async (req, res) => {
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

const patchUserSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  role: z.enum(['user', 'accountant', 'admin', 'partner', 'developer']).optional(),
  isActive: z.boolean().optional(),
});

router.patch('/users/:id', asyncHandler(async (req, res) => {
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

  const [updated] = await db.update(users)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(users.id, req.params.id))
    .returning({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      isActive: users.isActive,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    });

  if ('isActive' in body) {
    await auditLog({
      entityType: 'user',
      entityId: target.id,
      userId: req.user!.id,
      action: body.isActive ? 'admin.user.reactivated' : 'admin.user.deactivated',
      before: { isActive: target.isActive },
      after: { isActive: body.isActive },
    });
  } else if (body.name !== undefined || body.role !== undefined) {
    await auditLog({
      entityType: 'user',
      entityId: target.id,
      userId: req.user!.id,
      action: 'admin.user.updated',
      before: { name: target.name, role: target.role },
      after: { name: updated.name, role: updated.role },
    });
  }

  res.json({ user: updated });
}));

// Hard delete. Default: only succeeds when the user owns no data (409 HAS_DATA
// with counts otherwise). ?purge=true also removes everything they own, unless
// any of their expenses is synced to Zoho (409 ZOHO_LINKED).
router.delete('/users/:id', asyncHandler(async (req, res) => {
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

router.post('/users/:id/reset-password', asyncHandler(async (req, res) => {
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

// ── Categories ─────────────────────────────────────────────────────────────

router.get('/categories', asyncHandler(async (_req, res) => {
  const cats = await db.query.expenseCategories.findMany({
    orderBy: (c, { asc }) => [asc(c.name)],
  });
  res.json({ categories: cats });
}));

router.post('/categories', asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
  }).parse(req.body);

  const [cat] = await db.insert(expenseCategories).values(body).returning();
  res.status(201).json({ category: cat });
}));

router.patch('/categories/:id', asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    isActive: z.boolean().optional(),
  }).parse(req.body);

  const [updated] = await db.update(expenseCategories)
    .set(body)
    .where(eq(expenseCategories.id, req.params.id))
    .returning();

  res.json({ category: updated });
}));

// ── App Connections (app-to-app API keys) ──────────────────────────────────

router.get('/connections', asyncHandler(async (_req, res) => {
  const conns = await db.query.appConnections.findMany({
    columns: { apiKeyHash: false },
    orderBy: (c, { asc }) => [asc(c.appName)],
  });
  res.json({ connections: conns });
}));

router.post('/connections', asyncHandler(async (req, res) => {
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

router.patch('/connections/:id', asyncHandler(async (req, res) => {
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
