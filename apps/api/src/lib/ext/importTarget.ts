import type {
  CreateExpenseInput,
  ImportAttachment,
  ImportAuditEntry,
  ImportNote,
  ImportOwnerRef,
  ImportTargetPort,
} from '@midas/import';
import { DrizzleImportTargetPort } from '../import/drizzleImportTarget';

const DRY_RUN_USER_SENTINEL = '00000000-0000-4000-8000-dryrun000001';

/**
 * When dryRun + EXT_AUTO_PROVISION_USERS, missing emails resolve to a sentinel
 * so ImportService continues per-item validation without writing users.
 */
export class ExtImportTargetPort implements ImportTargetPort {
  private readonly inner = new DrizzleImportTargetPort();

  constructor(private readonly opts: { dryRun: boolean; autoProvision: boolean }) {}

  findExistingByOwner(owner: ImportOwnerRef) {
    return this.inner.findExistingByOwner(owner);
  }

  async resolveUserIdByEmail(email: string) {
    const id = await this.inner.resolveUserIdByEmail(email);
    if (id) return id;
    if (this.opts.dryRun && this.opts.autoProvision) return DRY_RUN_USER_SENTINEL;
    return null;
  }

  resolveCategoryIdByName(name: string) {
    return this.inner.resolveCategoryIdByName(name);
  }

  createExpense(input: CreateExpenseInput) {
    return this.inner.createExpense(input);
  }

  addAttachment(expenseId: string, attachment: ImportAttachment) {
    return this.inner.addAttachment(expenseId, attachment);
  }

  addNote(expenseId: string, note: ImportNote) {
    return this.inner.addNote(expenseId, note);
  }

  writeAuditEntry(expenseId: string, entry: ImportAuditEntry) {
    return this.inner.writeAuditEntry(expenseId, entry);
  }
}
