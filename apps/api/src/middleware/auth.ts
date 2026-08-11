import { createHash } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import type { UserRole } from '@midas/shared';
import { env } from '../config/env';
import { db } from '../db/index';
import { appConnections, users } from '../db/schema';
import { roleAllowed } from '../lib/roles';
import { issueSessionCookie, shouldRefreshSession } from '../lib/session';

export interface AuthenticatedUser {
  id: string;
  username: string;
  /** Optional — identity is the username. */
  email: string | null;
  name: string;
  role: UserRole;
}

export type AppConnection = typeof appConnections.$inferSelect;

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      appConnection?: AppConnection;
    }
  }
}

interface JwtPayload {
  sub: string;
  email: string | null;
  role: UserRole;
  iat?: number;
}

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.token as string | undefined;
  if (!token) {
    res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });
    return;
  }

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
    const user = await db.query.users.findFirst({
      where: eq(users.id, payload.sub),
    });
    if (!user || !user.isActive) {
      res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'User not found or inactive' } });
      return;
    }
    req.user = { id: user.id, username: user.username, email: user.email, name: user.name, role: user.role };

    // Sliding session: any use of a day-old token re-issues a fresh 30-day
    // cookie, so active users (web + extension) stay signed in.
    if (shouldRefreshSession(payload.iat, Date.now())) {
      issueSessionCookie(res, { id: user.id, email: user.email, role: user.role });
    }

    next();
  } catch {
    res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Invalid or expired token' } });
  }
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });
      return;
    }
    if (!roleAllowed(req.user.role, roles)) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } });
      return;
    }
    next();
  };
}

export type { ExtScope } from './requireScope';
export { requireScope } from './requireScope';

export async function authenticateApiKey(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'API key required' } });
    return;
  }
  const apiKey = authHeader.slice(7);
  const keyHash = createHash('sha256').update(apiKey).digest('hex');

  const conn = await db.query.appConnections.findFirst({
    where: (t, { eq: eqOp, and }) => and(eqOp(t.apiKeyHash, keyHash), eqOp(t.isActive, true)),
  });

  if (!conn) {
    res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Invalid API key' } });
    return;
  }

  await db.update(appConnections)
    .set({ lastUsedAt: new Date() })
    .where(eq(appConnections.id, conn.id));

  req.appConnection = conn;
  next();
}
