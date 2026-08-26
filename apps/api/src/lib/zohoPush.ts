import path from 'path';
import fs from 'fs/promises';
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/index';
import { expenses, receipts } from '../db/schema';
import { env } from '../config/env';
import { auditLog } from './audit';
import { isPartnerExpense } from './expenseKind';
import {
  zoho, ZohoServiceError, resolveBooksVendorId, attachReceiptToBooksExpense,
  fetchBooksExpenseAccounts,
  type ZohoPushResult,
} from './zoho';
import { auditPostedAccounts, RECEIPT_WARNING_PREFIX } from './zohoAccountAudit';
import { logger } from './logger';
import { buildZohoServicePayload, type PayloadExpense } from './zohoPayload';
import { resolveCategoryEntityAccountId } from './categoryZohoAccounts';
import { classifyZohoError } from './zohoErrors';
import { syncExpenseToTransaction } from './syncExpenseTransaction';
import { isCompanyZohoEnabled } from './companies';

const RETRY_DELAYS_MS = [2_000, 5_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Push with auto-retry for transient failures (network/429/5xx) only. */
async function pushWithRetry(payload: ReturnType<typeof buildZohoServicePayload>): Promise<ZohoPushResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    try {
      return await zoho.pushExpense(payload);
    } catch (err) {
      lastErr = err;
      if (!classifyZohoError(err).retryable) throw err;
    }
  }
  throw lastErr;
}

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
  if (isPartnerExpense(expense)) {
    return {
      ok: false, status: 409, code: 'PARTNER_EXPENSE_NOT_PUSHABLE',
      message: 'Partner expenses are tracked separately and are never pushed to Zoho',
    };
  }
  if (!expense.zohoEntity) {
    return { ok: false, status: 409, code: 'MISSING_ZOHO_ENTITY', message: 'zohoEntity must be set before pushing to Zoho' };
  }
  if (!(await isCompanyZohoEnabled(expense.zohoEntity))) {
    return {
      ok: false, status: 409, code: 'COMPANY_ZOHO_DISABLED',
      message: `Company "${expense.zohoEntity}" does not post to Zoho`,
    };
  }
  if (!expense.categoryId && !expense.zohoExpenseAccountId) {
    return { ok: false, status: 409, code: 'MISSING_CATEGORY', message: 'Category must be set before pushing to Zoho' };
  }
  if (!expense.paymentMethodId) {
    return { ok: false, status: 409, code: 'MISSING_PAYMENT_METHOD', message: 'Payment method must be set before pushing to Zoho' };
  }

  const categoryEntityAccountId = await resolveCategoryEntityAccountId(expense.categoryId, expense.zohoEntity);
  const payload = buildZohoServicePayload({ ...expense, categoryEntityAccountId });
  // Best-effort vendor: match or create a Books vendor from the merchant so
  // the Zoho record is searchable by name. Never blocks the push.
  payload.vendor_id = await resolveBooksVendorId(expense.merchant, payload.brand);
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
    const result = await pushWithRetry(payload);

    // The integration service can silently rewrite account ids per brand, which books
    // the expense against accounts nobody chose in Midas. Read the record back and
    // record a warning when it does — the push itself still succeeded.
    const audit = auditPostedAccounts(
      { accountId: payload.account_id, paidThroughAccountId: payload.paid_through_account_id },
      result.zohoExpenseId && !result.dryRun
        ? await fetchBooksExpenseAccounts(result.zohoExpenseId, payload.brand)
        : null,
    );
    if (audit.mismatched) {
      logger.warn(
        { expenseId: expense.id, brand: payload.brand, mismatches: audit.mismatches },
        'Zoho stored different accounts than Midas sent',
      );
      await auditLog({
        entityType: 'expense',
        entityId: expense.id,
        userId: actorUserId,
        action: 'zoho.account_mismatch',
        metadata: { brand: payload.brand, mismatches: audit.mismatches },
      });
    }

    const [updated] = await db.update(expenses)
      .set({
        status: 'approved',
        integrationStatus: 'synced',
        zohoExpenseId: result.zohoExpenseId,
        zohoSyncedAt: result.syncedAt,
        zohoSyncError: audit.warning,
        updatedAt: new Date(),
      })
      .where(eq(expenses.id, expense.id))
      .returning();

    // Everything from here on is bookkeeping AFTER the Zoho record exists.
    // None of it may reach the outer catch: that catch sets
    // integrationStatus:'failed', and a failed expense is re-pushable — so a
    // database blip in the mirror write, the receipt lookup, the warning write
    // or the audit insert would turn a push that succeeded into a duplicate
    // expense in Zoho Books. Contain it here and let the push stand.
    let finalExpense = updated;
    try {
      await syncExpenseToTransaction(updated);

      // Best-effort receipt attachment: the Zoho record exists either way, so a
      // failed attach never fails the push — but it must never be silent either.
      // A bare catch here hid an entire class of outage: when the uploads mount
      // changed, every readFile threw and receipts stopped reaching Zoho while
      // pushes still reported success.
      let receiptAttached = false;
      let receiptProblem: string | null = null;
      if (result.zohoExpenseId && !result.dryRun) {
        const receipt = await db.query.receipts.findFirst({
          where: eq(receipts.expenseId, expense.id),
          orderBy: [asc(receipts.uploadedAt)],
        });
        if (receipt) {
          try {
            const buffer = await fs.readFile(path.join(env.UPLOADS_DIR, receipt.storagePath));
            receiptAttached = await attachReceiptToBooksExpense(
              result.zohoExpenseId,
              { buffer, filename: receipt.filename, mimeType: receipt.mimeType },
              payload.brand,
            );
            if (!receiptAttached) receiptProblem = 'Zoho rejected the receipt upload';
          } catch (err) {
            receiptProblem = `receipt file could not be read (${receipt.storagePath})`;
            logger.error(
              { err, expenseId: expense.id, storagePath: receipt.storagePath, uploadsDir: env.UPLOADS_DIR },
              'Receipt unreadable — expense pushed to Zoho without its receipt',
            );
          }
          if (receiptProblem && !receiptAttached) {
            logger.warn(
              { expenseId: expense.id, zohoExpenseId: result.zohoExpenseId, reason: receiptProblem },
              'Zoho expense created without a receipt attachment',
            );
          }
        }
      }

      // Surface a missing receipt where the accountant will see it. The expense
      // stays synced — the Zoho record is real and must never be re-pushed.
      if (receiptProblem) {
        const warning = [
          audit.warning,
          `[${RECEIPT_WARNING_PREFIX}] Pushed to Zoho without its receipt — ${receiptProblem}.`,
        ].filter(Boolean).join(' ').slice(0, 500);
        const [rewarned] = await db.update(expenses)
          .set({ zohoSyncError: warning, updatedAt: new Date() })
          .where(eq(expenses.id, expense.id))
          .returning();
        if (rewarned) finalExpense = rewarned;
      }

      await auditLog({
        entityType: 'expense',
        entityId: expense.id,
        userId: actorUserId,
        action: 'zoho.pushed',
        after: result,
        metadata: {
          idempotencyKey: payload.idempotencyKey,
          dryRun: result.dryRun ?? false,
          vendorId: payload.vendor_id ?? null,
          receiptAttached,
          receiptProblem,
        },
      });
    } catch (err) {
      // The Zoho expense exists. Losing the mirror row, the receipt warning or
      // the audit entry is bad, but reporting a failure the caller would retry
      // is worse — that is how one expense becomes two in Zoho Books.
      logger.error(
        { err, expenseId: expense.id, zohoExpenseId: result.zohoExpenseId },
        'Bookkeeping failed after a successful Zoho expense push',
      );
    }

    return { ok: true, expense: finalExpense, zoho: result };
  } catch (err) {
    const zohoErr = err instanceof ZohoServiceError ? err : null;
    const { category } = classifyZohoError(err);
    const syncError = `[${category}] ${zohoErr?.message ?? (err instanceof Error ? err.message : String(err))}`.slice(0, 500);

    await db.update(expenses)
      .set({
        status: 'approved',
        integrationStatus: 'failed',
        zohoSyncError: syncError,
        zohoRequestId: zohoErr?.requestId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(expenses.id, expense.id));

    const failedRow = await db.query.expenses.findFirst({ where: eq(expenses.id, expense.id) });
    if (failedRow) await syncExpenseToTransaction(failedRow);

    await auditLog({
      entityType: 'expense',
      entityId: expense.id,
      userId: actorUserId,
      action: 'zoho.failed',
      metadata: {
        error: zohoErr?.message ?? String(err),
        code: zohoErr?.code ?? 'ZOHO_SYNC_FAILED',
        category,
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
