import { env } from '../config/env';
import {
  buildZohoServicePayload,
  resolvePaidThroughAccountId,
  type ZohoServicePayload,
  type PayloadExpense,
} from './zohoPayload';
import { resolveBrandFromEntity } from './zohoBrand';

export interface ZohoReadinessCheck {
  label: string;
  pass: boolean;
}

export interface ZohoMappedPayload {
  expenseId: string;
  merchant: string;
  amount: string;
  currency: string;
  date: string;
  description: string | null;
  referenceNumber?: string | null;
  zohoEntity: string;
  categoryName: string | null;
  paymentMethodLabel: string | null;
  brand: string;
}

export interface ZohoReadinessResult {
  ready: boolean;
  /** True when Midas already has a Zoho Books id — not a failure, just already done. */
  synced: boolean;
  missing: string[];
  warnings: string[];
  zohoMode: 'mock' | 'dry-run' | 'live';
  mappedPayload: ZohoMappedPayload | null;
  // Full generic payload Midas would propose to the integration service (preview only —
  // no network call, no Zoho record). Always present so accountants can review the shape.
  servicePayload: ZohoServicePayload;
  checks: ZohoReadinessCheck[];
}

interface ReadinessExpense extends PayloadExpense {
  status: string;
  zohoExpenseId: string | null;
  messages?: { requestType: string | null; isResolved: boolean }[];
}

function resolveZohoMode(): 'mock' | 'dry-run' | 'live' {
  if (env.ZOHO_MODE === 'mock') return 'mock';
  if (env.ZOHO_DRY_RUN) return 'dry-run';
  return 'live';
}

export function evaluateZohoReadiness(expense: ReadinessExpense): ZohoReadinessResult {
  const mode = resolveZohoMode();
  const missing: string[] = [];
  const warnings: string[] = [];

  const isApproved = expense.status === 'approved' || expense.status === 'zoho_sync_failed';
  const hasReceipt = (expense.receipts?.length ?? 0) > 0;
  const hasExpenseAccount = !!(expense.categoryId || expense.zohoExpenseAccountId);
  const hasPaymentMethod = !!expense.paymentMethodId;
  // Push refuses unmapped cards (MISSING_ZOHO_PAID_THROUGH) — surface it here.
  // Must match the payload rule exactly: a free-text label is not a mapping.
  const paidThroughAccountId = resolvePaidThroughAccountId(expense.paymentMethod?.zohoAccountName);
  const hasPaidThrough = !!paidThroughAccountId;
  const hasZohoEntity = !!expense.zohoEntity;
  const alreadySynced = !!expense.zohoExpenseId;
  const hasSubmitter = !!expense.userId;
  const hasAmount = !!expense.amount && Number(expense.amount) > 0;
  const hasMerchant = !!expense.merchant?.trim();
  const hasDate = !!expense.date;
  const hasOpenRequests = expense.messages?.some(
    (m) => m.requestType && !m.isResolved,
  ) ?? false;

  const checks: ZohoReadinessCheck[] = [
    { label: 'Approved', pass: isApproved },
    { label: 'Merchant name', pass: hasMerchant },
    { label: 'Amount > 0', pass: hasAmount },
    { label: 'Expense date', pass: hasDate },
    { label: 'Submitter (user)', pass: hasSubmitter },
    { label: 'Expense account set', pass: hasExpenseAccount },
    { label: 'Payment method set', pass: hasPaymentMethod },
    { label: 'Payment method mapped to Zoho account', pass: hasPaidThrough },
    { label: 'Accounting entity (Zoho brand)', pass: hasZohoEntity },
    { label: 'Receipt attached', pass: hasReceipt },
    { label: 'No open accountant requests', pass: !hasOpenRequests },
  ];

  if (!isApproved) missing.push('expense must be approved');
  if (!hasMerchant) missing.push('merchant name');
  if (!hasAmount) missing.push('valid amount');
  if (!hasDate) missing.push('expense date');
  if (!hasSubmitter) missing.push('submitter (user)');
  if (!hasExpenseAccount) missing.push('expense account (Zoho COA or category)');
  if (!hasPaymentMethod) missing.push('payment method');
  if (!hasPaidThrough) {
    // A label in zoho_account_name looks mapped in the UI but cannot be sent to Zoho.
    missing.push(
      expense.paymentMethod?.zohoAccountName
        ? `payment method is mapped to "${expense.paymentMethod.zohoAccountName}", which is not a Zoho account id — re-pick the account (Settings → Payment Methods)`
        : 'Zoho paid-through mapping on the payment method (Settings → Payment Methods)',
    );
  }
  if (!hasZohoEntity) missing.push('accounting entity (zohoEntity)');
  if (!hasReceipt) missing.push('receipt attachment');
  if (hasOpenRequests) missing.push('unresolved accountant requests');

  if (mode !== 'live') {
    warnings.push(`Zoho is in ${mode} mode — no live writes will occur`);
  }
  if (expense.reimbursementStatus === 'pending') {
    warnings.push('reimbursement is pending — coordinate with payroll');
  }
  if (paidThroughAccountId) {
    warnings.push(`payment method maps to Zoho account: ${paidThroughAccountId}`);
  }

  const ready = missing.length === 0 && !alreadySynced;
  const brand = resolveBrandFromEntity(expense.zohoEntity) ?? env.ZOHO_DEFAULT_BRAND;

  const mappedPayload: ZohoMappedPayload | null = ready ? {
    expenseId: expense.id,
    merchant: expense.merchant,
    amount: expense.amount,
    currency: expense.currency,
    date: expense.date,
    description: expense.description,
    referenceNumber: expense.referenceNumber ?? null,
    zohoEntity: expense.zohoEntity!,
    categoryName: expense.zohoExpenseAccountName ?? expense.category?.name ?? null,
    paymentMethodLabel: expense.paymentMethod?.label ?? null,
    brand,
  } : null;

  const servicePayload = buildZohoServicePayload(expense);

  return {
    ready,
    synced: alreadySynced,
    missing,
    warnings,
    zohoMode: mode,
    mappedPayload,
    servicePayload,
    checks,
  };
}
