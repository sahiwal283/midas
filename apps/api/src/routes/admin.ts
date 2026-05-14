import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { db } from '../db/index';
import { users, expenseCategories, appConnections } from '../db/schema';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler, notFound, createError } from '../middleware/error';
import { auditLog } from '../lib/audit';

const router = Router();
router.use(authenticate, requireRole('admin'));

// ── Users ──────────────────────────────────────────────────────────────────

router.get('/users', asyncHandler(async (_req, res) => {
  const rows = await db.query.users.findMany({
    columns: { passwordHash: false },
    orderBy: (u, { asc }) => [asc(u.name)],
  });
  res.json({ users: rows });
}));

const createUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  role: z.enum(['user', 'accountant', 'admin']),
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
  role: z.enum(['user', 'accountant', 'admin']).optional(),
  isActive: z.boolean().optional(),
});

router.patch('/users/:id', asyncHandler(async (req, res) => {
  const body = patchUserSchema.parse(req.body);

  const target = await db.query.users.findFirst({ where: eq(users.id, req.params.id) });
  if (!target) throw notFound('User not found');

  if ('isActive' in body && body.isActive === false && req.params.id === req.user!.id) {
    throw createError('You cannot deactivate your own account', 400, 'SELF_DEACTIVATION');
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
  const body = z.object({ isActive: z.boolean() }).parse(req.body);
  const [updated] = await db.update(appConnections)
    .set(body)
    .where(eq(appConnections.id, req.params.id))
    .returning({ id: appConnections.id, appName: appConnections.appName, isActive: appConnections.isActive });
  res.json({ connection: updated });
}));

export default router;
