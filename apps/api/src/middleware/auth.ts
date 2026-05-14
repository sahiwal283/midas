import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { db } from '../db/index';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';
import type { UserRole } from '@midas/shared';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
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
    req.user = { id: user.id, email: user.email, name: user.name, role: user.role };
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
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } });
      return;
    }
    next();
  };
}

// App-to-app API key auth (for external app integrations)
export async function authenticateApiKey(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'API key required' } });
    return;
  }
  const apiKey = authHeader.slice(7);

  // We store the hash; compare by hashing the incoming key
  // For now, simple lookup — production should use crypto.timingSafeEqual
  const { createHash } = await import('crypto');
  const keyHash = createHash('sha256').update(apiKey).digest('hex');

  const { appConnections } = await import('../db/schema');
  const conn = await db.query.appConnections.findFirst({
    where: (t, { eq, and }) => and(eq(t.apiKeyHash, keyHash), eq(t.isActive, true)),
  });

  if (!conn) {
    res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Invalid API key' } });
    return;
  }

  // Update last used
  await db.update(appConnections)
    .set({ lastUsedAt: new Date() })
    .where(eq(appConnections.id, conn.id));

  (req as Request & { appConnection: typeof conn }).appConnection = conn;
  next();
}
