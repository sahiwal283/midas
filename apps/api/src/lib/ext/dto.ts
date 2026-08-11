import { env } from '../../config/env';
import type { ExpenseSourceContext } from '../../db/schema';
import { toWireExpenseStatus, type IntegrationStatus, type LegacyExpenseStatus } from '../transactionStatus';

type ExpenseRow = {
  id: string;
  merchant: string;
  amount: string;
  currency: string;
  date: string;
  description: string | null;
  status: string;
  integrationStatus?: string | null;
  reimbursementStatus: string;
  sourceApp: string | null;
  sourceRefId: string | null;
  sourceLabel: string | null;
  sourceUrl: string | null;
  sourceType: string | null;
  sourceContext: ExpenseSourceContext | null;
  externalUserId: string | null;
  zohoEntity: string | null;
  zohoExpenseId: string | null;
  zohoSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  reviewedAt: Date | null;
  category?: { id: string; name: string } | null;
  paymentMethod?: { id: string; label: string } | null;
  user?: { id: string; name: string; email: string } | null;
  receipts?: Array<{
    id: string;
    filename: string;
    mimeType: string;
    ocrStatus: string;
    sha256?: string | null;
  }>;
};

export function midasExpenseUrl(expenseId: string): string {
  const base = (env.MIDAS_WEB_BASE_URL || env.CORS_ORIGIN).replace(/\/$/, '');
  return `${base}/expenses/${expenseId}`;
}

export function toExtExpenseDto(row: ExpenseRow) {
  const ctx = row.sourceContext ?? {};
  const eventId = typeof ctx.eventId === 'string' ? ctx.eventId : null;
  const location = ctx.location !== undefined ? (ctx.location as string | null) : null;
  const cardUsed = ctx.cardUsed !== undefined ? (ctx.cardUsed as string | null) : null;
  const midasUrl = midasExpenseUrl(row.id);

  const wireStatus = toWireExpenseStatus(
    row.status as LegacyExpenseStatus,
    (row.integrationStatus ?? (row.zohoExpenseId ? 'synced' : 'not_required')) as IntegrationStatus,
  );

  return {
    id: row.id,
    merchant: row.merchant,
    amount: row.amount,
    currency: row.currency,
    date: row.date,
    description: row.description,
    status: wireStatus,
    reimbursementStatus: row.reimbursementStatus,
    sourceApp: row.sourceApp,
    sourceRefId: row.sourceRefId,
    sourceLabel: row.sourceLabel,
    sourceUrl: row.sourceUrl,
    sourceType: row.sourceType,
    eventId,
    externalUserId: row.externalUserId,
    location,
    cardUsed,
    sourceContext: ctx,
    category: row.category ? { id: row.category.id, name: row.category.name } : null,
    paymentMethod: row.paymentMethod
      ? { id: row.paymentMethod.id, label: row.paymentMethod.label }
      : null,
    user: row.user
      ? { id: row.user.id, name: row.user.name, email: row.user.email }
      : null,
    receipts: (row.receipts ?? []).map((r) => ({
      id: r.id,
      filename: r.filename,
      mimeType: r.mimeType,
      ocrStatus: r.ocrStatus,
      contentPath: `/api/v1/ext/expenses/${row.id}/receipts/${r.id}/content`,
      sha256: r.sha256 ?? null,
    })),
    // Company that paid. `company` is the preferred name; `zohoEntity` is kept
    // as a deprecated alias so existing consumers keep working.
    company: row.zohoEntity,
    zohoEntity: row.zohoEntity,
    zohoExpenseId: row.zohoExpenseId,
    zohoSyncedAt: row.zohoSyncedAt?.toISOString() ?? null,
    midasUrl,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
  };
}

export const EXT_EXPENSE_WITH = {
  category: { columns: { id: true, name: true } },
  paymentMethod: { columns: { id: true, label: true } },
  user: { columns: { id: true, name: true, email: true } },
  receipts: {
    columns: {
      id: true,
      filename: true,
      mimeType: true,
      ocrStatus: true,
      sha256: true,
    },
  },
} as const;
