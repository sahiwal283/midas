import { resolveBrandFromEntity } from './zohoBrand';
import { buildPoIdempotencyKey } from './zohoIds';
import { env } from '../config/env';

export { buildPoIdempotencyKey } from './zohoIds';

/** Line item as stored/edited in Midas before Zoho push. */
export interface ZohoPoLineItemPayload {
  lineNumber: number;
  description: string;
  quantity: string;
  unit: string | null;
  unitPrice: string;
  tax: string;
  total: string;
  zohoItemId: string | null;
}

/**
 * Internal Midas PO payload (not sent verbatim to Zoho).
 * Use {@link toZohoBooksPoCreateBody} before POSTing to the integration service.
 */
export interface ZohoPoServicePayload {
  idempotencyKey: string;
  transactionId: string;
  poNumber: string | null;
  vendor: { name: string; zohoVendorId: string | null };
  date: string;
  currency: string;
  taxTotal: string;
  total: string;
  brand: string;
  zohoEntity: string | null;
  lineItems: ZohoPoLineItemPayload[];
  receipt: { count: number } | null;
  source: {
    app: string;
    type: string | null;
    id: string | null;
    url: string | null;
    label: string | null;
  };
}

/**
 * Wire body for POST /zoho/purchaseorders/create (Zoho Books proxy).
 * Do NOT include camelCase `lineItems` / nested `source` — Zoho treats unknown
 * keys as Books fields and rejects them (e.g. lineItems max 100 chars).
 */
export interface ZohoBooksPoCreateBody {
  idempotencyKey: string;
  /** Also sent so Zoho stores a stable reference when the service does not yet enforce idempotency. */
  reference_number: string;
  vendor_id: string;
  date: string;
  line_items: Array<{
    item_id: string;
    quantity: number;
    rate: number;
    name?: string;
  }>;
}

export interface PayloadPurchaseOrder {
  id: string;
  vendorName: string;
  zohoVendorId?: string | null;
  poNumber?: string | null;
  transactionDate: string;
  currency: string;
  taxTotal: string;
  total: string;
  zohoEntity: string | null;
  sourceApp?: string | null;
  sourceType?: string | null;
  sourceRefId?: string | null;
  sourceUrl?: string | null;
  sourceLabel?: string | null;
  lineItems: ZohoPoLineItemPayload[];
  receiptCount?: number;
}

export function buildZohoPoServicePayload(po: PayloadPurchaseOrder): ZohoPoServicePayload {
  const brand = resolveBrandFromEntity(po.zohoEntity) ?? env.ZOHO_DEFAULT_BRAND;
  return {
    idempotencyKey: buildPoIdempotencyKey(po.id),
    transactionId: po.id,
    poNumber: po.poNumber ?? null,
    vendor: {
      name: po.vendorName,
      zohoVendorId: po.zohoVendorId ?? null,
    },
    date: po.transactionDate,
    currency: po.currency,
    taxTotal: po.taxTotal,
    total: po.total,
    brand,
    zohoEntity: po.zohoEntity,
    lineItems: po.lineItems,
    receipt: po.receiptCount && po.receiptCount > 0 ? { count: po.receiptCount } : null,
    source: {
      app: po.sourceApp ?? 'midas',
      type: po.sourceType ?? 'purchase_order',
      id: po.sourceRefId ?? null,
      url: po.sourceUrl ?? null,
      label: po.sourceLabel ?? null,
    },
  };
}

/** Convert Midas PO payload → Zoho Books create body for the integration service. */
export function toZohoBooksPoCreateBody(payload: ZohoPoServicePayload): ZohoBooksPoCreateBody {
  const vendorId = payload.vendor.zohoVendorId?.trim();
  if (!vendorId) {
    throw new Error('zohoVendorId is required to create a Zoho purchase order');
  }
  const line_items = payload.lineItems
    .filter((li) => li.zohoItemId?.trim())
    .map((li) => ({
      item_id: li.zohoItemId!.trim(),
      quantity: Number(li.quantity),
      rate: Number(li.unitPrice),
      name: li.description || undefined,
    }));
  if (line_items.length === 0) {
    throw new Error('At least one line item with a Zoho item id is required');
  }
  return {
    idempotencyKey: payload.idempotencyKey,
    reference_number: payload.idempotencyKey.slice(0, 50),
    vendor_id: vendorId,
    date: payload.date,
    line_items,
  };
}
