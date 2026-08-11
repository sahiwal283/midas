import { Router, type Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { eq, or, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { users } from '../db/schema';
import { env } from '../config/env';
import { authenticate } from '../middleware/auth';
import { asyncHandler, createError } from '../middleware/error';
import { auditLog } from '../lib/audit';
import { inviteState } from '../lib/invites';

const router = Router();

// Accepts a username or an email. `email` is kept as an alias so existing
// clients keep working; identity is the username now, and email is optional.
const loginSchema = z.object({
  identifier: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  password: z.string().min(1),
}).refine((v) => Boolean(v.identifier ?? v.email), {
  message: 'identifier (username or email) is required',
  path: ['identifier'],
});

// Sliding 30-day sessions — shared with OIDC and the auth middleware refresh.
import { issueSessionCookie } from '../lib/session';

router.post('/login', asyncHandler(async (req, res) => {
  if (env.AUTH_MODE === 'authentik' && !env.ALLOW_LOCAL_BREAK_GLASS) {
    res.status(403).json({ error: { code: 'LOCAL_AUTH_DISABLED', message: 'Local login is disabled. Use SSO to sign in.' } });
    return;
  }

  const body = loginSchema.parse(req.body);
  const identifier = (body.identifier ?? body.email ?? '').trim();

  // Username first, then email — a user without an email can still sign in.
  const user = await db.query.users.findFirst({
    where: or(
      sql`lower(${users.username}) = ${identifier.toLowerCase()}`,
      eq(users.email, identifier.toLowerCase()),
    ),
  });
  if (!user || !user.isActive || !user.passwordHash) {
    res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password' } });
    return;
  }

  const valid = await bcrypt.compare(body.password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password' } });
    return;
  }

  await db.update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, user.id));

  issueSessionCookie(res, user);

  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      defaultZohoEntity: user.defaultZohoEntity,
      defaultPaymentMethodId: user.defaultPaymentMethodId,
    },
  });
}));

router.post('/logout', (_req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

// Shared shape for GET /me and PATCH /me. hasPassword is a boolean-only signal
// (the hash never leaves the API) so the UI can detect SSO-only accounts.
const ME_COLUMNS = {
  id: true, username: true, email: true, name: true, role: true,
  department: true, costCenter: true,
  defaultZohoEntity: true, defaultPaymentMethodId: true,
  passwordHash: true,
} as const;

function meShape(user: { passwordHash: string | null } & Record<string, unknown>) {
  const { passwordHash, ...rest } = user;
  return { ...rest, hasPassword: passwordHash !== null };
}

router.get('/me', authenticate, asyncHandler(async (req, res) => {
  // req.user only carries id/username/email/name/role — fetch the wizard defaults too.
  const user = await db.query.users.findFirst({
    where: eq(users.id, req.user!.id),
    columns: ME_COLUMNS,
  });
  res.json({ user: user ? meShape(user) : req.user });
}));

const patchMeSchema = z.object({
  name: z.string().min(1).max(100),
});

router.patch('/me', authenticate, asyncHandler(async (req, res) => {
  const { name } = patchMeSchema.parse(req.body);

  const target = await db.query.users.findFirst({ where: eq(users.id, req.user!.id) });
  if (!target) throw createError('User not found', 404, 'NOT_FOUND');

  await db.update(users)
    .set({ name, updatedAt: new Date() })
    .where(eq(users.id, target.id));

  await auditLog({
    entityType: 'user',
    entityId: target.id,
    userId: target.id,
    action: 'user.profile_updated',
    before: { name: target.name },
    after: { name },
  });

  const user = await db.query.users.findFirst({
    where: eq(users.id, target.id),
    columns: ME_COLUMNS,
  });
  res.json({ user: user ? meShape(user) : req.user });
}));

// ── Self-service password change ─────────────────────────────────────────────

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

router.post('/change-password', authenticate, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

  const user = await db.query.users.findFirst({ where: eq(users.id, req.user!.id) });
  if (!user) throw createError('User not found', 404, 'NOT_FOUND');

  if (!user.passwordHash) {
    throw createError('Your account signs in with SSO — password is managed in Authentik.', 409, 'NO_PASSWORD');
  }

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    throw createError('Current password is incorrect', 403, 'INVALID_PASSWORD');
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await db.update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.id, user.id));

  await auditLog({
    entityType: 'user',
    entityId: user.id,
    userId: user.id,
    action: 'user.password_changed',
    metadata: { email: user.email },
  });

  // Re-issue the session so the cookie's issue time reflects the change.
  issueSessionCookie(res, user);

  res.json({ ok: true });
}));

// ── Invitation acceptance (public — the invitee has no session yet) ──────────

router.get('/invite/:token', asyncHandler(async (req, res) => {
  const token = req.params.token;
  const user = await db.query.users.findFirst({ where: eq(users.inviteToken, token) });

  if (!user || !user.isActive || inviteState(user, token, new Date()) !== 'valid') {
    res.json({ valid: false });
    return;
  }
  res.json({ valid: true, name: user.name, email: user.email });
}));

const acceptInviteSchema = z.object({
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

router.post('/invite/:token', asyncHandler(async (req, res) => {
  const token = req.params.token;
  const { password } = acceptInviteSchema.parse(req.body);

  const user = await db.query.users.findFirst({ where: eq(users.inviteToken, token) });
  if (!user || !user.isActive || inviteState(user, token, new Date()) !== 'valid') {
    throw createError('This invite link is invalid or has expired', 409, 'INVITE_INVALID');
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await db.update(users)
    .set({
      passwordHash,
      inviteToken: null,
      inviteExpiresAt: null,
      lastLoginAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  await auditLog({
    entityType: 'user',
    entityId: user.id,
    userId: user.id,
    action: 'user.invite_accepted',
    metadata: { email: user.email },
  });

  issueSessionCookie(res, user);

  res.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
}));

export default router;
