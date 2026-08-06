import { env } from '../config/env';
import { resolveBrandFromEntity } from './zohoBrand';

// Payload Midas sends to POST /zoho/expenses/create_books on the Zoho Integration Service.
// Flat account_id / paid_through_account_id match Zoho Books + the integration service contract
// (Trade Show uses the same field names). Nested category/paymentMethod remain for readiness UI.
export interface ZohoServicePayload {
  // Stable, deterministic key for duplicate prevention on the service side.
  idempotencyKey: string;
  expenseId: string;
  merchant: string;
  amount: string;
  currency: string;
  date: string;
  description: string | null;
  /** Zoho Books expense COA account_id (required for live create). */
  account_id: string | null;
  /** Zoho Books paid-through account_id (card / reimbursement liability). */
  paid_through_account_id: string | null;
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
  zohoExpenseAccountId?: string | null;
  zohoExpenseAccountName?: string | null;
  reimbursementStatus: string;
  userId: string | null;
  sourceApp?: string | null;
  sourceType?: string | null;
  sourceRefId?: string | null;
  sourceUrl?: string | null;
  sourceLabel?: string | null;
  category?: { name: string; zohoAccountId?: string | null } | null;
  paymentMethod?: { label: string; zohoAccountName: string | null } | null;
  receipts?: { id: string }[];
}

// Deterministic idempotency key — same expense always yields the same key, so a retry
// can never create a duplicate Zoho record once the service honors the key.
export function buildIdempotencyKey(expenseId: string): string {
  return `midas-expense-${expenseId}`;
}

/** Prefer numeric Zoho account ids stored in zoho_account_name; ignore free-text labels. */
export function resolvePaidThroughAccountId(zohoAccountName: string | null | undefined): string | null {
  if (!zohoAccountName) return null;
  const trimmed = zohoAccountName.trim();
  // Zoho Books account ids are long numeric strings.
  if (/^\d{10,}$/.test(trimmed)) return trimmed;
  return null;
}

export function buildZohoServicePayload(expense: PayloadExpense): ZohoServicePayload {
  // Prefer live per-expense Zoho COA pick; fall back to static category map (Trade Show).
  const accountId =
    expense.zohoExpenseAccountId?.trim()
    || expense.category?.zohoAccountId?.trim()
    || null;
  const paidThrough = resolvePaidThroughAccountId(expense.paymentMethod?.zohoAccountName);
  const brand = resolveBrandFromEntity(expense.zohoEntity) ?? env.ZOHO_DEFAULT_BRAND;

  return {
    idempotencyKey: buildIdempotencyKey(expense.id),
    expenseId: expense.id,
    merchant: expense.merchant,
    amount: expense.amount,
    currency: expense.currency,
    date: expense.date,
    description: expense.description,
    account_id: accountId,
    paid_through_account_id: paidThrough,
    category: {
      id: expense.categoryId,
      name: expense.zohoExpenseAccountName ?? expense.category?.name ?? null,
      proposedZohoAccount: accountId,
    },
    paymentMethod: {
      id: expense.paymentMethodId,
      label: expense.paymentMethod?.label ?? null,
      proposedPaidThroughAccount: paidThrough ?? expense.paymentMethod?.zohoAccountName ?? null,
    },
    // Heuristic until decision A (reimbursable vs company-card) is finalized by accounting.
    reimbursable: expense.reimbursementStatus !== 'not_requested',
    submitter: { userId: expense.userId },
    brand,
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
