import { describe, it, expect, beforeEach } from 'vitest';
import { ImportService } from '../ImportService';
import type {
  CreateExpenseInput,
  ImportAttachment,
  ImportAuditEntry,
  ImportNote,
  ImportOwnerRef,
  ImportRecord,
  ImportSource,
  ImportTargetPort,
} from '../types';

/** In-memory fake target — exercises the framework without any real DB or ORM. */
class FakeTargetPort implements ImportTargetPort {
  expenses: Array<CreateExpenseInput & { id: string }> = [];
  attachments: Record<string, ImportAttachment[]> = {};
  notes: Record<string, ImportNote[]> = {};
  auditEntries: Record<string, ImportAuditEntry[]> = {};
  users = new Map<string, string>([
    ['alice@example.com', 'user-alice'],
    ['bob@example.com', 'user-bob'],
  ]);
  categories = new Map<string, string>([['Travel - Flight', 'cat-flight']]);
  private nextId = 1;

  async findExistingByOwner(owner: ImportOwnerRef) {
    const found = this.expenses.find((e) => e.ownerType === owner.ownerType && e.ownerId === owner.ownerId);
    return found ? { expenseId: found.id } : null;
  }

  async resolveUserIdByEmail(email: string) {
    return this.users.get(email) ?? null;
  }

  async resolveCategoryIdByName(name: string) {
    return this.categories.get(name) ?? null;
  }

  async createExpense(input: CreateExpenseInput) {
    const id = input.id ?? `generated-${this.nextId++}`;
    this.expenses.push({ ...input, id });
    return { id };
  }

  // exposed for assertions
  lastCreated() {
    return this.expenses[this.expenses.length - 1];
  }

  async addAttachment(expenseId: string, attachment: ImportAttachment) {
    (this.attachments[expenseId] ??= []).push(attachment);
  }

  async addNote(expenseId: string, note: ImportNote) {
    (this.notes[expenseId] ??= []).push(note);
  }

  async writeAuditEntry(expenseId: string, entry: ImportAuditEntry) {
    (this.auditEntries[expenseId] ??= []).push(entry);
  }
}

function sourceOf(records: ImportRecord[]): ImportSource {
  return {
    name: 'fake-source',
    async *fetchRecords() {
      for (const r of records) yield r;
    },
  };
}

const baseRecord: ImportRecord = {
  externalId: 'ext-1',
  owner: { ownerType: 'trade_show', ownerId: 'booth-42' },
  submitterEmail: 'alice@example.com',
  merchant: 'Marriott',
  amount: 199.5,
  date: '2026-01-15',
};

describe('ImportService', () => {
  let target: FakeTargetPort;

  beforeEach(() => {
    target = new FakeTargetPort();
  });

  it('imports a valid record and preserves owner/merchant/amount', async () => {
    const service = new ImportService(target);
    const report = await service.run(sourceOf([baseRecord]));

    expect(report.totals).toEqual({ imported: 1, skipped: 0, failed: 0 });
    expect(target.expenses).toHaveLength(1);
    expect(target.expenses[0].ownerType).toBe('trade_show');
    expect(target.expenses[0].ownerId).toBe('booth-42');
    expect(target.expenses[0].merchant).toBe('Marriott');
    expect(target.expenses[0].amount).toBe(199.5);
  });

  it('preserves the supplied ID when the target honors it', async () => {
    const service = new ImportService(target);
    await service.run(sourceOf([{ ...baseRecord, preserveId: 'fixed-uuid-123' }]));
    expect(target.expenses[0].id).toBe('fixed-uuid-123');
  });

  it('preserves timestamps and source label/url', async () => {
    const service = new ImportService(target);
    await service.run(
      sourceOf([
        {
          ...baseRecord,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-02T00:00:00.000Z',
          sourceLabel: 'Expo West 2026 — Booth 42',
          sourceUrl: 'https://argo.example/events/7',
        },
      ]),
    );
    expect(target.expenses[0].createdAt).toBe('2025-01-01T00:00:00.000Z');
    expect(target.expenses[0].updatedAt).toBe('2025-01-02T00:00:00.000Z');
    expect(target.expenses[0].sourceLabel).toBe('Expo West 2026 — Booth 42');
    expect(target.expenses[0].sourceUrl).toBe('https://argo.example/events/7');
  });

  it('preserves sourceContext, externalUserId, and Zoho ids', async () => {
    const service = new ImportService(target);
    await service.run(
      sourceOf([
        {
          ...baseRecord,
          sourceType: 'trade_show_event',
          externalUserId: 'ts-user-9',
          sourceContext: { eventId: 'evt-1', location: 'Hall A' },
          zohoEntity: 'haute_brands',
          zohoExpenseId: 'zoho-99',
        },
      ]),
    );
    const row = target.lastCreated();
    expect(row.sourceType).toBe('trade_show_event');
    expect(row.externalUserId).toBe('ts-user-9');
    expect(row.sourceContext).toEqual({ eventId: 'evt-1', location: 'Hall A' });
    expect(row.zohoEntity).toBe('haute_brands');
    expect(row.zohoExpenseId).toBe('zoho-99');
  });

  it('resolves category by name when provided', async () => {
    const service = new ImportService(target);
    await service.run(sourceOf([{ ...baseRecord, categoryName: 'Travel - Flight' }]));
    expect(target.expenses[0].categoryId).toBe('cat-flight');
  });

  it('leaves categoryId null when the category name does not match', async () => {
    const service = new ImportService(target);
    await service.run(sourceOf([{ ...baseRecord, categoryName: 'Unknown Category' }]));
    expect(target.expenses[0].categoryId).toBeNull();
  });

  it('preserves attachments with OCR metadata', async () => {
    const service = new ImportService(target);
    const attachment: ImportAttachment = {
      externalId: 'file-1',
      filename: 'receipt.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1024,
      source: { type: 'path', path: '/tmp/receipt.jpg' },
      ocr: { status: 'done', text: 'Marriott $199.50', provider: 'document_ai', confidence: 0.9 },
    };
    await service.run(sourceOf([{ ...baseRecord, attachments: [attachment] }]));
    const expenseId = target.expenses[0].id;
    expect(target.attachments[expenseId]).toEqual([attachment]);
  });

  it('preserves notes', async () => {
    const service = new ImportService(target);
    const note: ImportNote = { body: 'Approved verbally by manager', authorEmail: 'bob@example.com' };
    await service.run(sourceOf([{ ...baseRecord, notes: [note] }]));
    const expenseId = target.expenses[0].id;
    expect(target.notes[expenseId]).toEqual([note]);
  });

  it('preserves real audit history when present', async () => {
    const service = new ImportService(target);
    const entry: ImportAuditEntry = { action: 'expense.approved', actorEmail: 'bob@example.com' };
    await service.run(sourceOf([{ ...baseRecord, auditHistory: [entry] }]));
    const expenseId = target.expenses[0].id;
    expect(target.auditEntries[expenseId]).toEqual([entry]);
  });

  it('writes a single synthetic migration event when no audit history is supplied', async () => {
    const service = new ImportService(target);
    await service.run(sourceOf([baseRecord]));
    const expenseId = target.expenses[0].id;
    expect(target.auditEntries[expenseId]).toHaveLength(1);
    expect(target.auditEntries[expenseId][0].action).toBe('expense.migrated');
  });

  it('skips a record whose owner already exists, without updating it', async () => {
    const service = new ImportService(target);
    await service.run(sourceOf([baseRecord]));
    const report = await service.run(sourceOf([{ ...baseRecord, merchant: 'Different Merchant' }]));

    expect(report.totals).toEqual({ imported: 0, skipped: 1, failed: 0 });
    expect(target.expenses).toHaveLength(1);
    expect(target.expenses[0].merchant).toBe('Marriott'); // unchanged
  });

  it('fails a record when the submitter email has no matching Midas user', async () => {
    const service = new ImportService(target);
    const report = await service.run(sourceOf([{ ...baseRecord, submitterEmail: 'unknown@example.com' }]));

    expect(report.totals).toEqual({ imported: 0, skipped: 0, failed: 1 });
    expect(report.results[0].reason).toContain('unknown@example.com');
    expect(target.expenses).toHaveLength(0);
  });

  it('fails validation for missing required fields without throwing', async () => {
    const service = new ImportService(target);
    const report = await service.run(sourceOf([{ ...baseRecord, merchant: '' }]));
    expect(report.totals.failed).toBe(1);
    expect(report.results[0].reason).toMatch(/merchant/);
  });

  it('dry run reports what would happen without writing anything', async () => {
    const service = new ImportService(target);
    const report = await service.run(sourceOf([baseRecord]), { dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.totals).toEqual({ imported: 1, skipped: 0, failed: 0 });
    expect(target.expenses).toHaveLength(0);
  });

  it('processes multiple records independently, isolating one failure from the rest', async () => {
    const service = new ImportService(target);
    const report = await service.run(
      sourceOf([
        baseRecord,
        { ...baseRecord, externalId: 'ext-2', owner: { ownerType: 'trade_show', ownerId: 'booth-43' }, submitterEmail: 'nope@example.com' },
        { ...baseRecord, externalId: 'ext-3', owner: { ownerType: 'trade_show', ownerId: 'booth-44' } },
      ]),
    );

    expect(report.totals).toEqual({ imported: 2, skipped: 0, failed: 1 });
    expect(target.expenses).toHaveLength(2);
  });
});
