import type {
  ImportOptions,
  ImportRecord,
  ImportRecordResult,
  ImportReport,
  ImportSource,
  ImportTargetPort,
} from './types';

const DEFAULT_STATUS = 'pending';
const DEFAULT_REIMBURSEMENT_STATUS = 'not_requested';
const DEFAULT_CURRENCY = 'USD';

/**
 * Orchestrates importing `ImportRecord`s from an `ImportSource` into Midas via
 * an `ImportTargetPort`, preserving IDs/timestamps/OCR metadata/attachments/
 * categories/notes/audit history where possible.
 *
 * Idempotent by design: a record whose `owner` (ownerType + ownerId) already
 * exists in Midas is skipped, never updated — safe to re-run after a partial
 * failure. See docs/IMPORT_FRAMEWORK.md.
 */
export class ImportService {
  constructor(private readonly target: ImportTargetPort) {}

  async run(source: ImportSource, options: ImportOptions = {}): Promise<ImportReport> {
    const dryRun = options.dryRun ?? false;
    const results: ImportRecordResult[] = [];

    for await (const record of source.fetchRecords()) {
      results.push(await this.importOne(record, dryRun));
    }

    const totals = results.reduce(
      (acc, r) => {
        acc[r.status] += 1;
        return acc;
      },
      { imported: 0, skipped: 0, failed: 0 },
    );

    return { sourceName: source.name, dryRun, totals, results };
  }

  private async importOne(record: ImportRecord, dryRun: boolean): Promise<ImportRecordResult> {
    try {
      const validationError = validateRecord(record);
      if (validationError) {
        return { externalId: record.externalId, status: 'failed', reason: validationError };
      }

      const existing = await this.target.findExistingByOwner(record.owner);
      if (existing) {
        return {
          externalId: record.externalId,
          status: 'skipped',
          midasExpenseId: existing.expenseId,
          reason: 'already_imported',
        };
      }

      const submitterUserId = await this.target.resolveUserIdByEmail(record.submitterEmail);
      if (!submitterUserId) {
        return {
          externalId: record.externalId,
          status: 'failed',
          reason: `USER_NOT_FOUND: no Midas user for submitterEmail=${record.submitterEmail}`,
        };
      }

      const categoryId = record.categoryName
        ? await this.target.resolveCategoryIdByName(record.categoryName)
        : null;

      let reviewedById: string | null = null;
      if (record.reviewedByEmail) {
        reviewedById = await this.target.resolveUserIdByEmail(record.reviewedByEmail);
      }

      if (dryRun) {
        return { externalId: record.externalId, status: 'imported', reason: 'dry_run' };
      }

      const created = await this.target.createExpense({
        id: record.preserveId,
        ownerType: record.owner.ownerType,
        ownerId: record.owner.ownerId,
        submitterUserId,
        merchant: record.merchant,
        amount: record.amount,
        currency: record.currency ?? DEFAULT_CURRENCY,
        date: record.date,
        description: record.description ?? null,
        categoryId,
        status: record.status ?? DEFAULT_STATUS,
        reimbursementStatus: record.reimbursementStatus ?? DEFAULT_REIMBURSEMENT_STATUS,
        reviewedById,
        reviewedAt: record.reviewedAt ?? null,
        createdAt: record.createdAt ?? null,
        updatedAt: record.updatedAt ?? null,
        sourceLabel: record.sourceLabel ?? null,
        sourceUrl: record.sourceUrl ?? null,
        sourceType: record.sourceType ?? null,
        externalUserId: record.externalUserId ?? null,
        sourceContext: record.sourceContext ?? null,
        zohoEntity: record.zohoEntity ?? null,
        zohoExpenseId: record.zohoExpenseId ?? null,
        zohoSyncedAt: record.zohoSyncedAt ?? null,
      });

      for (const attachment of record.attachments ?? []) {
        await this.target.addAttachment(created.id, attachment);
      }
      for (const note of record.notes ?? []) {
        await this.target.addNote(created.id, note);
      }

      const auditHistory = record.auditHistory ?? [];
      if (auditHistory.length > 0) {
        for (const entry of auditHistory) {
          await this.target.writeAuditEntry(created.id, entry);
        }
      } else {
        // No source history available — record a single synthetic migration event
        // rather than fabricating fine-grained history that never existed.
        await this.target.writeAuditEntry(created.id, {
          action: 'expense.migrated',
          metadata: { ownerType: record.owner.ownerType, externalId: record.externalId },
        });
      }

      return { externalId: record.externalId, status: 'imported', midasExpenseId: created.id };
    } catch (err) {
      return {
        externalId: record.externalId,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function validateRecord(record: ImportRecord): string | null {
  if (!record.externalId) return 'missing externalId';
  if (!record.owner?.ownerType || !record.owner?.ownerId) return 'missing owner.ownerType/ownerId';
  if (!record.submitterEmail) return 'missing submitterEmail';
  if (!record.merchant) return 'missing merchant';
  if (!Number.isFinite(record.amount) || record.amount < 0) return 'invalid amount';
  if (!record.date) return 'missing date';
  return null;
}
