import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { users } from '../db/schema';
import { env } from '../config/env';
import { authenticate } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

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

  res.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
}));

router.post('/logout', (_req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

router.get('/me', authenticate, asyncHandler(async (req, res) => {
  res.json({ user: req.user });
}));

export default router;
