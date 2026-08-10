import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import {
  expenseDetails,
  expenses,
  transactions,
  vendors,
} from '../db/schema';
import {
  deriveIntegrationStatus,
  expenseStatusToTransactionStatus,
  type LegacyExpenseStatus,
} from './transactionStatus';
import { normalizeMerchant } from './merchants';

type ExpenseRow = typeof expenses.$inferSelect;

/** Upsert vendors row from a merchant / vendor display name. */
export async function upsertVendorByName(name: string, zohoEntity?: string | null) {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const normalizedName = normalizeMerchant(trimmed).toLowerCase();
  const existing = await db.query.vendors.findFirst({
    where: eq(vendors.normalizedName, normalizedName),
  });
  if (existing) return existing;
  const [created] = await db.insert(vendors).values({
    name: trimmed,
    normalizedName,
    defaultEntity: zohoEntity ?? null,
  }).onConflictDoNothing().returning();
  if (created) return created;
  return db.query.vendors.findFirst({
    where: eq(vendors.normalizedName, normalizedName),
  });
}

/**
 * Mirror an expense row into transactions + expense_details (same UUID).
 * Keeps the unified transaction model in sync while expense APIs remain the write path.
 */
export async function syncExpenseToTransaction(expense: ExpenseRow): Promise<void> {
  const vendor = await upsertVendorByName(expense.merchant, expense.zohoEntity);
  const legacyStatus = expense.status as LegacyExpenseStatus;
  const integrationStatus =
    expense.integrationStatus
    ?? deriveIntegrationStatus({
      zohoRecordId: expense.zohoExpenseId,
      zohoEntity: expense.zohoEntity,
      legacyStatus,
    });

  await db.insert(transactions).values({
    id: expense.id,
    type: 'expense',
    userId: expense.userId,
    vendorId: vendor?.id ?? null,
    vendorName: expense.merchant,
    transactionDate: expense.date,
    currency: expense.currency,
    total: expense.amount,
    taxTotal: '0',
    description: expense.description,
    status: expenseStatusToTransactionStatus(legacyStatus),
    integrationStatus,
    sourceApp: expense.sourceApp,
    sourceRefId: expense.sourceRefId,
    sourceLabel: expense.sourceLabel,
    sourceUrl: expense.sourceUrl,
    sourceType: expense.sourceType,
    sourceContext: expense.sourceContext,
    externalUserId: expense.externalUserId,
    zohoEntity: expense.zohoEntity,
    zohoRecordId: expense.zohoExpenseId,
    zohoSyncedAt: expense.zohoSyncedAt,
    zohoSyncError: expense.zohoSyncError,
    zohoRequestId: expense.zohoRequestId,
    reviewedById: expense.reviewedById,
    reviewedAt: expense.reviewedAt,
    createdAt: expense.createdAt,
    updatedAt: expense.updatedAt,
  }).onConflictDoUpdate({
    target: transactions.id,
    set: {
      vendorId: vendor?.id ?? null,
      vendorName: expense.merchant,
      transactionDate: expense.date,
      currency: expense.currency,
      total: expense.amount,
      description: expense.description,
      status: expenseStatusToTransactionStatus(legacyStatus),
      integrationStatus,
      sourceApp: expense.sourceApp,
      sourceRefId: expense.sourceRefId,
      sourceLabel: expense.sourceLabel,
      sourceUrl: expense.sourceUrl,
      sourceType: expense.sourceType,
      sourceContext: expense.sourceContext,
      externalUserId: expense.externalUserId,
      zohoEntity: expense.zohoEntity,
      zohoRecordId: expense.zohoExpenseId,
      zohoSyncedAt: expense.zohoSyncedAt,
      zohoSyncError: expense.zohoSyncError,
      zohoRequestId: expense.zohoRequestId,
      reviewedById: expense.reviewedById,
      reviewedAt: expense.reviewedAt,
      updatedAt: expense.updatedAt,
    },
  });

  await db.insert(expenseDetails).values({
    transactionId: expense.id,
    categoryId: expense.categoryId,
    paymentMethodId: expense.paymentMethodId,
    reimbursementStatus: expense.reimbursementStatus,
    zohoExpenseAccountId: expense.zohoExpenseAccountId,
    zohoExpenseAccountName: expense.zohoExpenseAccountName,
  }).onConflictDoUpdate({
    target: expenseDetails.transactionId,
    set: {
      categoryId: expense.categoryId,
      paymentMethodId: expense.paymentMethodId,
      reimbursementStatus: expense.reimbursementStatus,
      zohoExpenseAccountId: expense.zohoExpenseAccountId,
      zohoExpenseAccountName: expense.zohoExpenseAccountName,
    },
  });
}

export async function removeSyncedTransaction(expenseId: string): Promise<void> {
  await db.delete(transactions).where(eq(transactions.id, expenseId));
}
