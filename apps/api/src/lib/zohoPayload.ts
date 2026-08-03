import { env } from '../config/env';

// Proposed payload that Midas would send to the Zoho Integration Service.
// This is GENERIC — it is not coupled to trade shows or any single source app, and it
// never requires an event_id. The integration service owns the actual Zoho mapping;
// Midas only proposes a normalized shape. This is preview/spec only — building it
// performs NO network call and creates NO Zoho record.
export interface ZohoServicePayload {
  // Stable, deterministic key for duplicate prevention on the service side.
  idempotencyKey: string;
  expenseId: string;
  merchant: string;
  amount: string;
  currency: string;
  date: string;
  description: string | null;
  // Accounting mappings are still accounting decisions — proposed* fields are placeholders
  // until the integration service / accounting confirm the Chart-of-Accounts and
  // paid-through account mappings.
  category: { id: string | null; name: string | null; proposedZohoAccount: string | null };
  paymentMethod: { id: string | null; label: string | null; proposedPaidThroughAccount: string | null };
  reimbursable: boolean;
  submitter: { userId: string | null };
  brand: string;
  zohoEntity: string | null;
  receipt: { count: number } | null;
  // Generic provenance — works for any source app (manual, browser extension, Argo, etc.).
  source: {
    app: string;
    type: string | null;
    id: string | null;
    url: string | null;
    label: string | null;
  };
}

export interface PayloadExpense {
  id: string;
  merchant: string;
  amount: string;
  currency: string;
  date: string;
  description: string | null;
  categoryId: string | null;
  paymentMethodId: string | null;
  zohoEntity: string | null;
  reimbursementStatus: string;
  userId: string | null;
  sourceApp?: string | null;
  sourceType?: string | null;
  sourceRefId?: string | null;
  sourceUrl?: string | null;
  sourceLabel?: string | null;
  category?: { name: string } | null;
  paymentMethod?: { label: string; zohoAccountName: string | null } | null;
  receipts?: { id: string }[];
}

// Deterministic idempotency key — same expense always yields the same key, so a retry
// can never create a duplicate Zoho record once the service honors the key.
export function buildIdempotencyKey(expenseId: string): string {
  return `midas-expense-${expenseId}`;
}

export function buildZohoServicePayload(expense: PayloadExpense): ZohoServicePayload {
  return {
    idempotencyKey: buildIdempotencyKey(expense.id),
    expenseId: expense.id,
    merchant: expense.merchant,
    amount: expense.amount,
    currency: expense.currency,
    date: expense.date,
    description: expense.description,
    category: {
      id: expense.categoryId,
      name: expense.category?.name ?? null,
      proposedZohoAccount: null, // accounting decision — see ZOHO_MAPPING_REVIEW §5
    },
    paymentMethod: {
      id: expense.paymentMethodId,
      label: expense.paymentMethod?.label ?? null,
      proposedPaidThroughAccount: expense.paymentMethod?.zohoAccountName ?? null,
    },
    // Heuristic until decision A (reimbursable vs company-card) is finalized by accounting.
    reimbursable: expense.reimbursementStatus !== 'not_requested',
    submitter: { userId: expense.userId },
    brand: env.ZOHO_DEFAULT_BRAND,
    zohoEntity: expense.zohoEntity,
    receipt: expense.receipts && expense.receipts.length > 0 ? { count: expense.receipts.length } : null,
    source: {
      app: expense.sourceApp ?? 'midas',
      type: expense.sourceType ?? null,
      id: expense.sourceRefId ?? null,
      url: expense.sourceUrl ?? null,
      label: expense.sourceLabel ?? null,
    },
  };
}
