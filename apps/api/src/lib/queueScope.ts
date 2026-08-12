import { and, eq, isNull, isNotNull, ne, or, type SQL } from 'drizzle-orm';
import { expenses } from '../db/schema';

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

/** SQL mirror of isDailyExpense. Filtering happens server-side, never in the client. */
export function scopeCondition(scope: QueueScope): SQL {
  const daily = or(isNull(expenses.sourceApp), eq(expenses.sourceApp, 'browser_extension'))!;
  return scope === 'daily'
    ? daily
    : and(isNotNull(expenses.sourceApp), ne(expenses.sourceApp, 'browser_extension'))!;
}
