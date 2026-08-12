import { and, eq, isNull, isNotNull, ne, or, type SQL } from 'drizzle-orm';
import { expenses } from '../db/schema';
// Type-only: this file (and its pure-function unit tests) must stay
// importable without a DATABASE_URL/JWT_SECRET — pulling in the real
// `createError` would drag in ../middleware/error -> ../lib/logger ->
// ../config/env, which process.exit(1)s outside a fully configured
// environment. We reuse the same AppError shape by hand instead.
import type { AppError } from '../middleware/error';

/** Which accountant review page an expense belongs to. */
export type QueueScope = 'event' | 'daily';

/**
 * Daily = entered in Midas or via the browser extension. Event = came from an
 * external app (trade_show, …). This mirrors the line lib/autoApprove.ts already
 * draws for auto-push, so the two review pages inherit a rule the system
 * already enforces. The two cases are exact complements: every expense belongs
 * to exactly one page.
 */
export function isDailyExpense(e: { sourceApp: string | null }): boolean {
  return e.sourceApp === null || e.sourceApp === 'browser_extension';
}

export function parseQueueScope(raw: string | undefined): QueueScope | undefined {
  return raw === 'event' || raw === 'daily' ? raw : undefined;
}

/**
 * Strict scope parsing for every endpoint that accepts `?scope=`. Absent
 * scope keeps meaning "unscoped" — several existing callers rely on that.
 * A *present* but unrecognised value (wrong case, `all`, an array from a
 * repeated query param, …) fails closed with a 400 instead of silently
 * falling back to unscoped and leaking both pages' rows into one query.
 */
export function requireQueueScope(raw: unknown): QueueScope | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') {
    const parsed = parseQueueScope(raw);
    if (parsed) return parsed;
  }
  const err = new Error(`Invalid scope: must be 'event' or 'daily'`) as AppError;
  err.statusCode = 400;
  err.code = 'INVALID_SCOPE';
  throw err;
}

/** SQL mirror of isDailyExpense. Filtering happens server-side, never in the client. */
export function scopeCondition(scope: QueueScope): SQL {
  const daily = or(isNull(expenses.sourceApp), eq(expenses.sourceApp, 'browser_extension'))!;
  return scope === 'daily'
    ? daily
    : and(isNotNull(expenses.sourceApp), ne(expenses.sourceApp, 'browser_extension'))!;
}
