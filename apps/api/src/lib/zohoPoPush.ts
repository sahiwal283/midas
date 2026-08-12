import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { purchaseOrders, transactionLineItems, transactions } from '../db/schema';
import { auditLog } from './audit';
import { zoho, ZohoServiceError, type ZohoPoPushResult } from './zoho';
import { buildZohoPoServicePayload, type PayloadPurchaseOrder } from './zohoPoPayload';
import { classifyZohoError } from './zohoErrors';
import { isCompanyZohoEnabled } from './companies';

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

  const payloadInput: PayloadPurchaseOrder = {
    id: tx.id,
    vendorName: tx.vendorName,
    zohoVendorId: tx.purchaseOrder?.zohoVendorId ?? null,
    poNumber: tx.purchaseOrder?.poNumber ?? null,
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

    await auditLog({
      entityType: 'transaction',
      entityId: tx.id,
      userId: actorUserId,
      action: 'zoho.po.pushed',
      after: result,
      metadata: { idempotencyKey: payload.idempotencyKey, dryRun: result.dryRun ?? false },
    });

    return { ok: true, transaction: updated, zoho: result };
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
