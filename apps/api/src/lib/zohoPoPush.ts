import path from 'path';
import fs from 'fs/promises';
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/index';
import { purchaseOrders, receipts, transactionLineItems, transactions } from '../db/schema';
import { env } from '../config/env';
import { auditLog } from './audit';
import { zoho, ZohoServiceError, attachReceiptToBooksPurchaseOrder, type ZohoPoPushResult } from './zoho';
import { buildZohoPoServicePayload, type PayloadPurchaseOrder } from './zohoPoPayload';
import {
  poReceiptProblem,
  poReceiptWarning,
  shouldAttemptPoReceiptAttach,
  type PoReceiptOutcome,
} from './zohoPoReceipt';
import { resolveBrandFromEntity } from './zohoBrand';
import { classifyZohoError } from './zohoErrors';
import { isCompanyZohoEnabled } from './companies';
import { resolveUserNames, toDateOnly } from './userNames';
import { tryEventDates } from './tradeShowEvents';
import { logger } from './logger';

const RETRY_DELAYS_MS = [2_000, 5_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pushWithRetry(payload: ReturnType<typeof buildZohoPoServicePayload>): Promise<ZohoPoPushResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    try {
      return await zoho.pushPurchaseOrder(payload);
    } catch (err) {
      lastErr = err;
      if (!classifyZohoError(err).retryable) throw err;
    }
  }
  throw lastErr;
}

export type ZohoPoPushOutcome =
  | { ok: true; transaction: typeof transactions.$inferSelect; zoho: ZohoPoPushResult }
  | { ok: false; status: 409 | 502; code: string; message: string; requestId?: string };

/**
 * Push a purchase-order transaction to Zoho via the integration service.
 * Idempotency key is midas-po-<transactionId>.
 */
export async function pushPurchaseOrderToZoho(
  transactionId: string,
  actorUserId: string,
): Promise<ZohoPoPushOutcome> {
  const tx = await db.query.transactions.findFirst({
    where: eq(transactions.id, transactionId),
    with: {
      purchaseOrder: true,
      lineItems: true,
    },
  });

  if (!tx || tx.type !== 'purchase_order') {
    return { ok: false, status: 409, code: 'NOT_A_PO', message: 'Transaction is not a purchase order' };
  }
  if (tx.status !== 'approved' && tx.integrationStatus !== 'failed') {
    return { ok: false, status: 409, code: 'NOT_APPROVED', message: 'PO must be approved before Zoho push' };
  }
  if (!tx.zohoEntity) {
    return { ok: false, status: 409, code: 'MISSING_ZOHO_ENTITY', message: 'zohoEntity must be set before pushing to Zoho' };
  }
  if (!(await isCompanyZohoEnabled(tx.zohoEntity))) {
    return {
      ok: false, status: 409, code: 'COMPANY_ZOHO_DISABLED',
      message: `Company "${tx.zohoEntity}" does not post to Zoho`,
    };
  }
  if (!tx.lineItems?.length) {
    return { ok: false, status: 409, code: 'MISSING_LINE_ITEMS', message: 'PO must have at least one line item' };
  }
  if (!tx.purchaseOrder?.zohoVendorId) {
    return {
      ok: false, status: 409, code: 'MISSING_ZOHO_VENDOR',
      message: 'Select a Zoho vendor before pushing this purchase order',
    };
  }
  if (tx.lineItems.some((li) => !li.zohoItemId)) {
    return {
      ok: false, status: 409, code: 'MISSING_ZOHO_ITEM',
      message: 'Every line item needs a Zoho item id before push',
    };
  }

  const receiptCount = await db.$count(receipts, eq(receipts.transactionId, tx.id));
  // Names, not ids: the Zoho note is read by accountants in Zoho Books.
  const names = await resolveUserNames([tx.userId, actorUserId]);
  // See zohoPush: best-effort, never fatal.
  const eventDates = await tryEventDates(tx.sourceContext?.eventId);

  const payloadInput: PayloadPurchaseOrder = {
    id: tx.id,
    vendorName: tx.vendorName,
    zohoVendorId: tx.purchaseOrder?.zohoVendorId ?? null,
    receiptCount,
    transactionDate: tx.transactionDate,
    currency: tx.currency,
    taxTotal: tx.taxTotal,
    total: tx.total,
    zohoEntity: tx.zohoEntity,
    sourceApp: tx.sourceApp,
    sourceType: tx.sourceType,
    sourceRefId: tx.sourceRefId,
    sourceUrl: tx.sourceUrl,
    sourceLabel: tx.sourceLabel,
    submitterName: tx.userId ? names.get(tx.userId) ?? null : null,
    submittedOn: toDateOnly(tx.createdAt),
    pushedByName: names.get(actorUserId) ?? null,
    pushedOn: toDateOnly(new Date()),
    eventStartDate: eventDates?.startDate ?? null,
    eventEndDate: eventDates?.endDate ?? null,
    lineItems: tx.lineItems
      .slice()
      .sort((a, b) => a.lineNumber - b.lineNumber)
      .map((li) => ({
        lineNumber: li.lineNumber,
        description: li.description,
        quantity: li.quantity,
        unit: li.unit,
        unitPrice: li.unitPrice,
        tax: li.tax,
        total: li.total,
        zohoItemId: li.zohoItemId,
      })),
  };

  const payload = buildZohoPoServicePayload(payloadInput);

  await db.update(transactions)
    .set({ integrationStatus: 'syncing', updatedAt: new Date() })
    .where(eq(transactions.id, tx.id));

  try {
    const result = await pushWithRetry(payload);

    const [updated] = await db.update(transactions)
      .set({
        status: 'approved',
        integrationStatus: 'synced',
        zohoRecordId: result.zohoPurchaseOrderId,
        zohoSyncedAt: result.syncedAt,
        zohoSyncError: null,
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, tx.id))
      .returning();

    // Best-effort receipt attachment: the Books PO exists either way, so a
    // failed attach never fails the push — but it must never be silent either.
    // The whole thing (lookup, file read, attach call, warning write) runs
    // inside one try/catch so nothing here can reach the outer catch below —
    // that catch marks integrationStatus 'failed', which the top of this
    // function treats as re-pushable, and a re-push would duplicate a PO that
    // already exists in Zoho. A DB blip during the receipt lookup or the
    // warning write must be swallowed here, the same as a Zoho-side failure.
    let receiptAttached = false;
    let receiptProblem: string | null = null;
    let finalTransaction = updated;
    // Skip entirely on a dry run: ZOHO_DRY_RUN defaults to true, and the attach
    // client always returns false under dry run — without this guard every
    // dry-run push with a receipt would be stamped "Zoho rejected the receipt
    // upload" for an attach that was never attempted.
    if (shouldAttemptPoReceiptAttach(result.zohoPurchaseOrderId, result.dryRun)) {
      try {
        const receipt = await db.query.receipts.findFirst({
          where: eq(receipts.transactionId, tx.id),
          orderBy: [asc(receipts.uploadedAt)],
        });

        let outcome: PoReceiptOutcome;
        if (!receipt) {
          // Spec Decision 6: a receipt-less PO pushes and is *flagged*. Not a
          // hard gate — blocking would strand every PO already in flight
          // without one — but it must not render as a clean "Created" either.
          outcome = { kind: 'none' };
        } else {
          try {
            const buffer = await fs.readFile(path.join(env.UPLOADS_DIR, receipt.storagePath));
            const attached = await attachReceiptToBooksPurchaseOrder(
              result.zohoPurchaseOrderId,
              { buffer, filename: receipt.filename, mimeType: receipt.mimeType },
              resolveBrandFromEntity(tx.zohoEntity) ?? env.ZOHO_DEFAULT_BRAND,
            );
            outcome = attached ? { kind: 'attached' } : { kind: 'rejected' };
          } catch (err) {
            outcome = { kind: 'unreadable', storagePath: receipt.storagePath };
            logger.error(
              { err, transactionId: tx.id, storagePath: receipt.storagePath, uploadsDir: env.UPLOADS_DIR },
              'Receipt unreadable — purchase order pushed to Zoho without its receipt',
            );
          }
        }

        receiptAttached = outcome.kind === 'attached';
        receiptProblem = poReceiptProblem(outcome);

        // Surface the problem where the accountant will see it. The row stays
        // synced — the Books PO is real and must never be re-pushed.
        if (receiptProblem) {
          const [rewarned] = await db.update(transactions)
            .set({ zohoSyncError: poReceiptWarning(receiptProblem), updatedAt: new Date() })
            .where(eq(transactions.id, tx.id))
            .returning();
          if (rewarned) finalTransaction = rewarned;
        }
      } catch (err) {
        // Receipt lookup or the warning write itself failed (e.g. a DB blip),
        // not the attach call. The Books PO already exists — log and move on
        // rather than let this escape to the outer catch.
        logger.error(
          { err, transactionId: tx.id, zohoPurchaseOrderId: result.zohoPurchaseOrderId },
          'Receipt bookkeeping failed after a successful Zoho PO push',
        );
      }
    }

    try {
      await auditLog({
        entityType: 'transaction',
        entityId: tx.id,
        userId: actorUserId,
        action: 'zoho.po.pushed',
        after: result,
        metadata: {
          idempotencyKey: payload.idempotencyKey,
          dryRun: result.dryRun ?? false,
          receiptAttached,
          receiptProblem,
        },
      });
    } catch (err) {
      // auditLog is an unguarded insert, so it is the last way a database blip
      // could reach the outer catch and mark this PO 'failed' — which invites a
      // re-push of a purchase order Zoho already has.
      logger.error(
        { err, transactionId: tx.id, zohoPurchaseOrderId: result.zohoPurchaseOrderId },
        'Audit write failed after a successful Zoho PO push',
      );
    }

    return { ok: true, transaction: finalTransaction, zoho: result };
  } catch (err) {
    const zohoErr = err instanceof ZohoServiceError ? err : null;
    const { category } = classifyZohoError(err);
    const syncError = `[${category}] ${zohoErr?.message ?? (err instanceof Error ? err.message : String(err))}`.slice(0, 500);

    await db.update(transactions)
      .set({
        integrationStatus: 'failed',
        zohoSyncError: syncError,
        zohoRequestId: zohoErr?.requestId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, tx.id));

    await auditLog({
      entityType: 'transaction',
      entityId: tx.id,
      userId: actorUserId,
      action: 'zoho.po.failed',
      metadata: {
        error: zohoErr?.message ?? String(err),
        code: zohoErr?.code ?? 'ZOHO_SYNC_FAILED',
        category,
        requestId: zohoErr?.requestId ?? null,
        idempotencyKey: payload.idempotencyKey,
      },
    });

    return {
      ok: false,
      status: 502,
      code: zohoErr?.code ?? 'ZOHO_SYNC_FAILED',
      message: 'Zoho PO push failed — marked for retry.',
      requestId: zohoErr?.requestId ?? undefined,
    };
  }
}

/** Ensure purchase_orders row exists (no-op helper for type narrowing). */
export async function ensurePurchaseOrderRow(transactionId: string): Promise<void> {
  const existing = await db.query.purchaseOrders.findFirst({
    where: eq(purchaseOrders.transactionId, transactionId),
  });
  if (!existing) {
    await db.insert(purchaseOrders).values({ transactionId });
  }
}

export async function replaceLineItems(
  transactionId: string,
  items: Array<{
    lineNumber: number;
    description: string;
    quantity: string;
    unit?: string | null;
    unitPrice: string;
    tax?: string;
    total: string;
    zohoItemId?: string | null;
    ocrConfidence?: string | null;
    needsReview?: boolean;
  }>,
): Promise<void> {
  await db.delete(transactionLineItems).where(eq(transactionLineItems.transactionId, transactionId));
  if (items.length === 0) return;
  await db.insert(transactionLineItems).values(
    items.map((li) => ({
      transactionId,
      lineNumber: li.lineNumber,
      description: li.description,
      quantity: li.quantity,
      unit: li.unit ?? null,
      unitPrice: li.unitPrice,
      tax: li.tax ?? '0',
      total: li.total,
      zohoItemId: li.zohoItemId ?? null,
      ocrConfidence: li.ocrConfidence ?? null,
      needsReview: li.needsReview ?? false,
    })),
  );
}
