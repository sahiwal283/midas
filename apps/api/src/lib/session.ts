import { Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { SESSION_TTL_MS } from './sessionPolicy';

export { SESSION_TTL_MS, REFRESH_AFTER_MS, shouldRefreshSession } from './sessionPolicy';

export function issueSessionCookie(res: Response, user: { id: string; email: string | null; role: string }): void {
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
    maxAge: SESSION_TTL_MS,
  });
}
