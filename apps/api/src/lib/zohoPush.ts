import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { expenses } from '../db/schema';
import { auditLog } from './audit';
import { zoho, ZohoServiceError, type ZohoPushResult } from './zoho';
import { buildZohoServicePayload, type PayloadExpense } from './zohoPayload';

export type PushableExpense = PayloadExpense & typeof expenses.$inferSelect;

export type ZohoPushOutcome =
  | { ok: true; expense: typeof expenses.$inferSelect; zoho: ZohoPushResult }
  | { ok: false; status: 409 | 502; code: string; message: string; requestId?: string };

/**
 * Validates and pushes one expense to Zoho. On success sets approved + synced;
 * on push failure sets zoho_sync_failed. Used by the accountant push route and
 * by daily-expense auto-push on submit.
 */
export async function pushExpenseToZoho(expense: PushableExpense, actorUserId: string): Promise<ZohoPushOutcome> {
  if (!expense.zohoEntity) {
    return { ok: false, status: 409, code: 'MISSING_ZOHO_ENTITY', message: 'zohoEntity must be set before pushing to Zoho' };
  }
  if (!expense.categoryId && !expense.zohoExpenseAccountId) {
    return { ok: false, status: 409, code: 'MISSING_CATEGORY', message: 'Category must be set before pushing to Zoho' };
  }
  if (!expense.paymentMethodId) {
    return { ok: false, status: 409, code: 'MISSING_PAYMENT_METHOD', message: 'Payment method must be set before pushing to Zoho' };
  }

  const payload = buildZohoServicePayload(expense);
  if (!payload.account_id) {
    return {
      ok: false, status: 409, code: 'MISSING_ZOHO_EXPENSE_ACCOUNT',
      message: 'No Zoho expense account on this expense — select one from the Zoho COA (or map a Trade Show category)',
    };
  }
  if (!payload.paid_through_account_id) {
    return {
      ok: false, status: 409, code: 'MISSING_ZOHO_PAID_THROUGH',
      message: 'Payment method has no Zoho paid-through account id (Admin → Payment Methods → Zoho Account)',
    };
  }

  try {
    const result = await zoho.pushExpense(payload);

    const [updated] = await db.update(expenses)
      .set({ status: 'approved', zohoExpenseId: result.zohoExpenseId, zohoSyncedAt: result.syncedAt, updatedAt: new Date() })
      .where(eq(expenses.id, expense.id))
      .returning();

    await auditLog({
      entityType: 'expense',
      entityId: expense.id,
      userId: actorUserId,
      action: 'zoho.pushed',
      after: result,
      metadata: { idempotencyKey: payload.idempotencyKey, dryRun: result.dryRun ?? false },
    });
    return { ok: true, expense: updated, zoho: result };
  } catch (err) {
    await db.update(expenses)
      .set({ status: 'zoho_sync_failed', updatedAt: new Date() })
      .where(eq(expenses.id, expense.id));

    const zohoErr = err instanceof ZohoServiceError ? err : null;
    await auditLog({
      entityType: 'expense',
      entityId: expense.id,
      userId: actorUserId,
      action: 'zoho.failed',
      metadata: {
        error: zohoErr?.message ?? String(err),
        code: zohoErr?.code ?? 'ZOHO_SYNC_FAILED',
        requestId: zohoErr?.requestId ?? null,
      },
    });

    const message = zohoErr?.code === 'ZOHO_AUTH_INVALID'
      ? 'Zoho Integration Service rejected Midas credentials (inbound auth). Check Authorization: Bearer token. Expense marked for retry.'
      : zohoErr?.code === 'ZOHO_AUTH_FORBIDDEN'
        ? 'Midas is not granted this Zoho brand/capability. Contact the Zoho Integration Service team. Expense marked for retry.'
        : 'Zoho push failed — expense marked for retry.';

    return { ok: false, status: 502, code: zohoErr?.code ?? 'ZOHO_SYNC_FAILED', message, requestId: zohoErr?.requestId ?? undefined };
  }
}
