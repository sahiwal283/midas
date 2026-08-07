import { Router, type Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { users } from '../db/schema';
import { env } from '../config/env';
import { authenticate } from '../middleware/auth';
import { asyncHandler, createError } from '../middleware/error';
import { auditLog } from '../lib/audit';
import { inviteState } from '../lib/invites';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function issueSessionCookie(res: Response, user: { id: string; email: string; role: string }) {
  const token = jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] },
  );

  res.cookie('token', token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    domain: env.COOKIE_DOMAIN,
    maxAge: 8 * 60 * 60 * 1000, // 8h
  });
}

router.post('/login', asyncHandler(async (req, res) => {
  if (env.AUTH_MODE === 'authentik' && !env.ALLOW_LOCAL_BREAK_GLASS) {
    res.status(403).json({ error: { code: 'LOCAL_AUTH_DISABLED', message: 'Local login is disabled. Use SSO to sign in.' } });
    return;
  }

  const { email, password } = loginSchema.parse(req.body);

  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (!user || !user.isActive || !user.passwordHash) {
    res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
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

router.get('/me', authenticate, asyncHandler(async (req, res) => {
  // req.user only carries id/email/name/role — fetch the wizard defaults too.
  const user = await db.query.users.findFirst({
    where: eq(users.id, req.user!.id),
    columns: { id: true, email: true, name: true, role: true, defaultZohoEntity: true, defaultPaymentMethodId: true },
  });
  res.json({ user: user ?? req.user });
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
