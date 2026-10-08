import { and, asc, eq, gt, isNull, or } from 'drizzle-orm';
import { db } from '../db/index';
import { appConnections, expenses, extEvents, type ExtEventPayload } from '../db/schema';
import type { ExtEventRow, HandOffExpense } from './extEvents';

/** Active, events-enabled connections that speak for a source app (see lib/ext/connectionScope). */
function enabledConnectionsFor(sourceApp: string) {
  return and(
    eq(appConnections.isActive, true),
    eq(appConnections.eventsEnabled, true),
    or(
      eq(appConnections.sourceApp, sourceApp),
      and(isNull(appConnections.sourceApp), eq(appConnections.appName, sourceApp)),
    ),
  );
}

export interface HandOffContext {
  expense: HandOffExpense;
  eventsEnabled: boolean;
  pingUrls: string[];
}

/** What notifyUser needs to decide a hand-off. Null when the expense is gone. */
export async function loadHandOffContext(expenseId: string): Promise<HandOffContext | null> {
  const expense = await db.query.expenses.findFirst({
    where: eq(expenses.id, expenseId),
    columns: {
      id: true, userId: true, sourceApp: true, sourceRefId: true,
      externalUserId: true, merchant: true, amount: true, status: true,
    },
  });
  if (!expense) return null;
  if (!expense.sourceApp || !expense.externalUserId) {
    return { expense, eventsEnabled: false, pingUrls: [] };
  }

  const conns = await db.query.appConnections.findMany({
    where: enabledConnectionsFor(expense.sourceApp),
    columns: { eventsPingUrl: true },
  });
  return {
    expense,
    eventsEnabled: conns.length > 0,
    pingUrls: conns.map((c) => c.eventsPingUrl).filter((u): u is string => Boolean(u)),
  };
}

export async function recordExtEvent(e: {
  sourceApp: string; type: string; expenseId: string; payload: ExtEventPayload;
}): Promise<void> {
  await db.insert(extEvents).values(e);
}

export async function listExtEvents(sourceApp: string, since: number, limit: number): Promise<ExtEventRow[]> {
  return db.select({
    seq: extEvents.seq, id: extEvents.id, type: extEvents.type,
    createdAt: extEvents.createdAt, payload: extEvents.payload,
  })
    .from(extEvents)
    .where(and(eq(extEvents.sourceApp, sourceApp), gt(extEvents.seq, since)))
    .orderBy(asc(extEvents.seq))
    .limit(limit);
}

/** Source apps with at least one active, events-enabled connection (for the sweep). */
export async function eventEnabledSourceApps(): Promise<string[]> {
  const conns = await db.query.appConnections.findMany({
    where: and(eq(appConnections.isActive, true), eq(appConnections.eventsEnabled, true)),
    columns: { appName: true, sourceApp: true },
  });
  return [...new Set(conns.map((c) => c.sourceApp ?? c.appName))];
}
