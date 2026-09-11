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
import { resolveUserNames, toDateOnly } from './userNames';
import { tryEventDates } from './tradeShowEvents';
import { receiptPushBlocker, normalizeWaiverReason, shouldRecordWaiver } from './receiptPushBlocker';
import { buildReceiptBundle, bundleReceiptProblem } from './receiptBundle';

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

export type PushableExpense = PayloadExpense & typeof expenses.$inferSelect & {
  receiptWaiverReason?: string | null;
  receiptWaivedById?: string | null;
};

export type ZohoPushOutcome =
  | { ok: true; expense: typeof expenses.$inferSelect; zoho: ZohoPushResult }
  | { ok: false; status: 400 | 409 | 502; code: string; message: string; requestId?: string };

export interface PushOptions {
  /**
   * An accountant's justification for pushing with no receipt. Only the
   * accountant routes pass this — `POST /expenses/:id/submit` is not
   * role-gated and never reads the field, so a submitter cannot self-waive.
   */
  receiptWaiver?: { reason: string };
}

/**
 * Validates and pushes one expense to Zoho. On success sets approved + synced;
 * on push failure sets zoho_sync_failed. Used by the accountant push route and
 * by daily-expense auto-push on submit.
 */
export async function pushExpenseToZoho(
  expense: PushableExpense,
  actorUserId: string,
  opts?: PushOptions,
): Promise<ZohoPushOutcome> {
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

  // The receipt rule is enforced here rather than in each route so every caller
  // inherits it — four call sites reach this function, and a rule remembered
  // four times is a rule that drifts.
  const suppliedReason = normalizeWaiverReason(opts?.receiptWaiver?.reason) ?? undefined;
  const hasReceipt = (expense.receipts?.length ?? 0) > 0;
  const receiptBlocker = receiptPushBlocker({
    hasReceipt,
    storedWaiverReason: expense.receiptWaiverReason ?? null,
    suppliedReason: opts?.receiptWaiver ? (suppliedReason ?? opts.receiptWaiver.reason) : undefined,
  });
  if (receiptBlocker) {
    return {
      ok: false,
      status: receiptBlocker.status,
      code: receiptBlocker.code,
      message: receiptBlocker.message,
    };
  }

  // Written before the push, not after: a push that fails still leaves the
  // justification on the record, so the retry reads it back instead of asking
  // the accountant to type it again. A row that is already waived keeps its
  // original reason — the first justification is the one that was reviewed,
  // and an expense that HAS a receipt is never waived at all, however the
  // caller filled the body. `shouldRecordWaiver` is the single expression of
  // that: it decides both the write below and the attribution further down,
  // so the row, the audit entry and the Zoho note can never disagree about
  // whether this push waived anything.
  const storedWaiver = normalizeWaiverReason(expense.receiptWaiverReason);
  const recordingWaiver = shouldRecordWaiver({
    hasReceipt,
    storedWaiverReason: expense.receiptWaiverReason ?? null,
    suppliedReason,
  });
  let waiverReason = storedWaiver;
  if (recordingWaiver && suppliedReason) {
    const waivedAt = new Date();
    await db.update(expenses)
      .set({
        receiptWaiverReason: suppliedReason,
        receiptWaivedById: actorUserId,
        receiptWaivedAt: waivedAt,
        updatedAt: waivedAt,
      })
      .where(eq(expenses.id, expense.id));
    waiverReason = suppliedReason;
    await auditLog({
      entityType: 'expense',
      entityId: expense.id,
      userId: actorUserId,
      action: 'expense.receipt_waived',
      after: { receiptWaiverReason: suppliedReason },
      metadata: { reason: suppliedReason },
    });
  }

  const categoryEntityAccountId = await resolveCategoryEntityAccountId(expense.categoryId, expense.zohoEntity);
  // Names, not ids: the Zoho note is read by accountants in Zoho Books.
  const names = await resolveUserNames([expense.userId, actorUserId, expense.receiptWaivedById ?? null]);
  // Event run dates live only in Argo. Best-effort: the note degrades to the
  // event name alone rather than the push failing on a cosmetic lookup.
  const eventDates = await tryEventDates(expense.sourceContext?.eventId);
  // Only a waiver this push actually recorded may name this actor. A stored
  // reason whose `receipt_waived_by_id` is NULL — the waiving accountant was
  // deleted, and the FK is ON DELETE SET NULL so the reason outlives them —
  // must fall through to buildZohoNote's unnamed "Receipt waived: <reason>"
  // form. Naming the retrying accountant there would put a false name on the
  // one line in Zoho that records who bypassed the control.
  const waivedById = expense.receiptWaivedById ?? (recordingWaiver ? actorUserId : null);
  const payload = buildZohoServicePayload({
    ...expense,
    categoryEntityAccountId,
    submitterName: expense.userId ? names.get(expense.userId) ?? null : null,
    submittedOn: toDateOnly(expense.createdAt),
    pushedByName: names.get(actorUserId) ?? null,
    pushedOn: toDateOnly(new Date()),
    eventStartDate: eventDates?.startDate ?? null,
    eventEndDate: eventDates?.endDate ?? null,
    receiptWaiverReason: waiverReason,
    receiptWaivedByName: waivedById ? names.get(waivedById) ?? null : null,
  });
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
        // Every receipt on the expense, in page order, merged into one file.
        // Zoho Books holds a single attachment per expense, so a second attach
        // would replace the first rather than add to it.
        const rows = await db.query.receipts.findMany({
          where: eq(receipts.expenseId, expense.id),
          orderBy: [asc(receipts.uploadedAt), asc(receipts.id)],
        });
        if (rows.length > 0) {
          let bundle: Awaited<ReturnType<typeof buildReceiptBundle>> | null = null;
          try {
            bundle = await buildReceiptBundle(rows, env.UPLOADS_DIR);
          } catch (err) {
            receiptProblem = `receipt file could not be read (${rows.map((r) => r.storagePath).join(', ')})`;
            logger.error(
              { err, expenseId: expense.id, storagePaths: rows.map((r) => r.storagePath), uploadsDir: env.UPLOADS_DIR },
              'Receipt unreadable — expense pushed to Zoho without its receipt',
            );
          }

          if (bundle) {
            if (bundle.file) {
              try {
                receiptAttached = await attachReceiptToBooksExpense(
                  result.zohoExpenseId,
                  bundle.file,
                  payload.brand,
                );
              } catch (err) {
                logger.error(
                  { err, expenseId: expense.id },
                  'Zoho receipt attach threw — expense pushed without its receipt',
                );
              }
            }
            receiptProblem = bundleReceiptProblem(bundle, receiptAttached);
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
