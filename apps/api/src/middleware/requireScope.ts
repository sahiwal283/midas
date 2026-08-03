import type { Request, Response, NextFunction } from 'express';

type ScopedRequest = Request & { appConnection?: { permissions?: string[] | null } };

/** Ext API scopes (docs/EXT_API_MERGE_LOCK.md). */
export type ExtScope =
  | 'ocr:process'
  | 'expenses:create'
  | 'expenses:read'
  | 'expenses:update'
  | 'expenses:delete'
  | 'receipts:create'
  | 'expenses:import'
  | 'expenses:review'
  | 'zoho:push';

/** Require a scope on the authenticated app connection. Empty permissions = deny all. */
export function requireScope(...scopes: ExtScope[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const scoped = req as ScopedRequest;
    if (!scoped.appConnection) {
      res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'API key required' } });
      return;
    }
    const granted = new Set(scoped.appConnection.permissions ?? []);
    const missing = scopes.filter((s) => !granted.has(s));
    if (missing.length > 0) {
      res.status(403).json({
        error: {
          code: 'MISSING_SCOPE',
          message: `Missing required scope(s): ${missing.join(', ')}`,
        },
      });
      return;
    }
    next();
  };
}
