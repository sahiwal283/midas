import { readFile } from 'fs/promises';
import { and, eq } from 'drizzle-orm';
import type {
  CreateExpenseInput,
  ImportAttachment,
  ImportAuditEntry,
  ImportNote,
  ImportOwnerRef,
  ImportTargetPort,
} from '@midas/import';
import { db } from '../../db/index';
import { auditLogs, expenseCategories, expenseMessages, expenses, receipts, users } from '../../db/schema';
import { storage } from '../storage';

/**
 * Bridges @midas/import onto Midas's own Drizzle/Postgres storage. This is Midas's
 * own storage adapter, not an external-system adapter — every embedder of Midas
 * can use this port as-is. Only the `ImportSource` (where records come from) is
 * embedder-specific, and is deliberately not implemented here — see
 * docs/IMPORT_FRAMEWORK.md.
 */
export class DrizzleImportTargetPort implements ImportTargetPort {
  /** expenseId -> submitter userId, used so notes without a resolvable author fall back sensibly. */
  private readonly submitterByExpenseId = new Map<string, string>();

  async findExistingByOwner(owner: ImportOwnerRef): Promise<{ expenseId: string } | null> {
    const existing = await db.query.expenses.findFirst({
      where: and(eq(expenses.sourceApp, owner.ownerType), eq(expenses.sourceRefId, owner.ownerId)),
    });
    return existing ? { expenseId: existing.id } : null;
  }

  async resolveUserIdByEmail(email: string): Promise<string | null> {
    const user = await db.query.users.findFirst({ where: eq(users.email, email) });
    return user?.id ?? null;
  }

  async resolveCategoryIdByName(name: string): Promise<string | null> {
    const category = await db.query.expenseCategories.findFirst({ where: eq(expenseCategories.name, name) });
    return category?.id ?? null;
  }

  async createExpense(input: CreateExpenseInput): Promise<{ id: string }> {
    const [row] = await db
      .insert(expenses)
      .values({
        id: input.id,
        userId: input.submitterUserId,
        categoryId: input.categoryId,
        sourceApp: input.ownerType,
        sourceRefId: input.ownerId,
        sourceLabel: input.sourceLabel,
        sourceUrl: input.sourceUrl,
        sourceType: input.sourceType ?? 'imported',
        sourceContext: (input.sourceContext ?? {}) as (typeof expenses.$inferInsert)['sourceContext'],
        externalUserId: input.externalUserId ?? null,
        merchant: input.merchant,
        amount: input.amount.toFixed(2),
        currency: input.currency,
        date: input.date,
        description: input.description,
        status: input.status as (typeof expenses.$inferInsert)['status'],
        reimbursementStatus: input.reimbursementStatus as (typeof expenses.$inferInsert)['reimbursementStatus'],
        reviewedById: input.reviewedById,
        reviewedAt: input.reviewedAt ? new Date(input.reviewedAt) : null,
        zohoEntity: input.zohoEntity ?? null,
        zohoExpenseId: input.zohoExpenseId ?? null,
        zohoSyncedAt: input.zohoSyncedAt ? new Date(input.zohoSyncedAt) : null,
        ...(input.createdAt ? { createdAt: new Date(input.createdAt) } : {}),
        ...(input.updatedAt ? { updatedAt: new Date(input.updatedAt) } : {}),
      })
      .returning({ id: expenses.id });

    this.submitterByExpenseId.set(row.id, input.submitterUserId);
    return { id: row.id };
  }

  async addAttachment(expenseId: string, attachment: ImportAttachment): Promise<void> {
    const buffer = await readAttachmentBytes(attachment);
    const stored = await storage.save(buffer, attachment.filename, attachment.mimeType);

    await db.insert(receipts).values({
      expenseId,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      storagePath: stored.storagePath,
      sha256: attachment.sha256 ?? null,
      ocrStatus: attachment.ocr?.status ?? 'pending',
      ocrText: attachment.ocr?.text ?? null,
      ocrRequestId: attachment.ocr?.requestId ?? null,
      ocrProvider: attachment.ocr?.provider ?? null,
      ocrConfidence: formatConfidence(attachment.ocr?.confidence),
      ocrOverallConfidence: formatConfidence(attachment.ocr?.overallConfidence),
      ocrNeedsReview: attachment.ocr?.needsReview ?? null,
      ocrReviewReasons: attachment.ocr?.reviewReasons ?? null,
      ocrErrorSummary: attachment.ocr?.errorSummary ?? null,
      ocrCostEstimateUsd: attachment.ocr?.costEstimateUsd != null ? String(attachment.ocr.costEstimateUsd) : null,
      ocrSubmittedAt: attachment.ocr?.submittedAt ? new Date(attachment.ocr.submittedAt) : null,
      ocrCompletedAt: attachment.ocr?.completedAt ? new Date(attachment.ocr.completedAt) : null,
      ...(attachment.createdAt ? { uploadedAt: new Date(attachment.createdAt) } : {}),
    });
  }

  async addNote(expenseId: string, note: ImportNote): Promise<void> {
    const authorId = note.authorEmail ? await this.resolveUserIdByEmail(note.authorEmail) : null;
    const senderId = authorId ?? this.submitterByExpenseId.get(expenseId);
    if (!senderId) {
      throw new Error(`addNote: could not resolve a sender for expense ${expenseId} (no authorEmail match and no known submitter)`);
    }

    await db.insert(expenseMessages).values({
      expenseId,
      senderId,
      body: note.body,
      isSystem: note.isSystem ?? true,
      ...(note.createdAt ? { createdAt: new Date(note.createdAt) } : {}),
    });
  }

  async writeAuditEntry(expenseId: string, entry: ImportAuditEntry): Promise<void> {
    const actorId = entry.actorEmail ? await this.resolveUserIdByEmail(entry.actorEmail) : null;

    await db.insert(auditLogs).values({
      entityType: 'expense',
      entityId: expenseId,
      userId: actorId,
      action: entry.action,
      before: entry.before ?? null,
      after: entry.after ?? null,
      metadata: entry.metadata ?? null,
      ...(entry.createdAt ? { createdAt: new Date(entry.createdAt) } : {}),
    });
  }
}

async function readAttachmentBytes(attachment: ImportAttachment): Promise<Buffer> {
  if (attachment.source.type === 'path') {
    return readFile(attachment.source.path);
  }
  const res = await fetch(attachment.source.url);
  if (!res.ok) throw new Error(`Failed to fetch attachment from ${attachment.source.url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function formatConfidence(value: number | null | undefined): string | null {
  return value != null ? value.toFixed(4) : null;
}
