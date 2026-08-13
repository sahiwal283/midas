import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { expenses, companies } from '../db/schema';
import { isDailyAutoPushCandidate } from './pendingCompletion';
import { evaluateZohoReadiness } from './zohoReadiness';
import { pushExpenseToZoho } from './zohoPush';
import { auditLog } from './audit';

export interface CompletionOutcome {
  autoPushed: boolean;
  status: string;
}

/**
 * Re-evaluates a pending daily expense after an edit or receipt upload and
 * auto-approves + pushes it when it became complete. No-ops for anything that
 * isn't a pending daily-eligible expense (event expenses, partner spend,
 * Zoho-disabled companies, already-reviewed states).
 */
export async function maybeAutoPushPending(expenseId: string, actorUserId: string): Promise<CompletionOutcome | null> {
  const expense = await db.query.expenses.findFirst({
    where: eq(expenses.id, expenseId),
    with: {
      receipts: true,
      category: { columns: { id: true, name: true, zohoAccountId: true } },
      paymentMethod: { columns: { id: true, label: true, zohoAccountName: true } },
      messages: { columns: { requestType: true, isResolved: true } },
    },
  });
  if (!expense || expense.status !== 'pending') return null;

  const company = expense.zohoEntity
    ? await db.query.companies.findFirst({ where: eq(companies.name, expense.zohoEntity) })
    : undefined;
  if (!isDailyAutoPushCandidate({
    sourceApp: expense.sourceApp,
    expenseKind: expense.expenseKind,
    companyZohoEnabled: company?.zohoEnabled,
  })) return null;

  const readiness = evaluateZohoReadiness({ ...expense, status: 'approved' });
  if (!readiness.ready) return null;

  const [approved] = await db.update(expenses)
    .set({ status: 'approved', updatedAt: new Date() })
    .where(eq(expenses.id, expense.id))
    .returning();
  await auditLog({
    entityType: 'expense',
    entityId: expense.id,
    userId: actorUserId,
    action: 'auto_approved',
    before: { status: 'pending' },
    after: { status: 'approved' },
    metadata: { reason: 'completed after submission', zohoMode: readiness.zohoMode },
  });

  const outcome = await pushExpenseToZoho({ ...expense, ...approved }, actorUserId);
  return {
    autoPushed: outcome.ok,
    status: outcome.ok ? 'approved' : 'zoho_sync_failed',
  };
}
