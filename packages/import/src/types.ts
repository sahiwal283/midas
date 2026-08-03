// ── Canonical import record ──────────────────────────────────────────────────
// The shape every ImportSource must produce, and every ImportTargetPort must
// accept. Deliberately has no fields specific to any one external system —
// see docs/IMPORT_FRAMEWORK.md for the design rationale.

export interface ImportOwnerRef {
  /** Opaque owning-application identifier, e.g. 'trade_show', 'argo', 'milo'. */
  ownerType: string;
  /** Opaque identifier for the specific record within that application. */
  ownerId: string;
}

export interface ImportOcrMetadata {
  status?: 'pending' | 'processing' | 'done' | 'failed';
  text?: string | null;
  requestId?: string | null;
  provider?: string | null;
  confidence?: number | null;
  overallConfidence?: number | null;
  needsReview?: boolean | null;
  reviewReasons?: string[] | null;
  errorSummary?: string | null;
  costEstimateUsd?: number | null;
  submittedAt?: string | null;
  completedAt?: string | null;
}

export type ImportAttachmentSource = { type: 'path'; path: string } | { type: 'url'; url: string };

export interface ImportAttachment {
  /** External ID for the attachment, if the source system has one — preserved for traceability. */
  externalId?: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  source: ImportAttachmentSource;
  /** Optional content checksum (hex SHA-256). Stored when provided; not re-verified by default. */
  sha256?: string | null;
  ocr?: ImportOcrMetadata | null;
  createdAt?: string;
}

export interface ImportNote {
  body: string;
  authorEmail?: string | null;
  isSystem?: boolean;
  createdAt?: string;
}

export interface ImportAuditEntry {
  action: string;
  actorEmail?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
  createdAt?: string;
}

export interface ImportRecord {
  /** Stable ID from the source system — required for idempotent re-runs. */
  externalId: string;
  /** Midas UUID to assign if the caller wants to preserve it exactly. Best-effort — see ImportTargetPort. */
  preserveId?: string;
  owner: ImportOwnerRef;
  submitterEmail: string;
  merchant: string;
  amount: number;
  currency?: string;
  date: string;
  description?: string | null;
  categoryName?: string | null;
  status?: string;
  reimbursementStatus?: string;
  reviewedByEmail?: string | null;
  reviewedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  sourceLabel?: string | null;
  sourceUrl?: string | null;
  sourceType?: string | null;
  externalUserId?: string | null;
  /** Opaque embedder context (eventId, location, cardUsed, …). */
  sourceContext?: Record<string, unknown> | null;
  zohoEntity?: string | null;
  zohoExpenseId?: string | null;
  zohoSyncedAt?: string | null;
  attachments?: ImportAttachment[];
  notes?: ImportNote[];
  auditHistory?: ImportAuditEntry[];
}

// ── Source: what an embedder implements per external system ─────────────────

export interface ImportSource {
  /** Identifies the source system in reports/logs, e.g. 'trade-show-app-v1.8'. */
  name: string;
  fetchRecords(): AsyncIterable<ImportRecord>;
}

// ── Target port: the bridge into Midas's own storage ─────────────────────────
// Implemented once per Midas deployment (e.g. apps/api/src/lib/import/drizzleImportTarget.ts)
// against Drizzle/Postgres. Kept as an interface so ImportService is testable
// with an in-memory fake and so the pipeline never depends on a specific ORM.

export interface CreateExpenseInput {
  /** Honored best-effort — the port may ignore this if the ID is already taken. */
  id?: string;
  ownerType: string;
  ownerId: string;
  submitterUserId: string;
  merchant: string;
  amount: number;
  currency: string;
  date: string;
  description: string | null;
  categoryId: string | null;
  status: string;
  reimbursementStatus: string;
  reviewedById: string | null;
  reviewedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  sourceLabel: string | null;
  sourceUrl: string | null;
  sourceType?: string | null;
  externalUserId?: string | null;
  sourceContext?: Record<string, unknown> | null;
  zohoEntity?: string | null;
  zohoExpenseId?: string | null;
  zohoSyncedAt?: string | null;
}

export interface ImportTargetPort {
  /** Idempotency check — the framework never updates an expense that already exists for this owner. */
  findExistingByOwner(owner: ImportOwnerRef): Promise<{ expenseId: string } | null>;
  resolveUserIdByEmail(email: string): Promise<string | null>;
  resolveCategoryIdByName(name: string): Promise<string | null>;
  createExpense(input: CreateExpenseInput): Promise<{ id: string }>;
  addAttachment(expenseId: string, attachment: ImportAttachment): Promise<void>;
  addNote(expenseId: string, note: ImportNote): Promise<void>;
  writeAuditEntry(expenseId: string, entry: ImportAuditEntry): Promise<void>;
}

// ── Reporting ─────────────────────────────────────────────────────────────────

export type ImportRecordStatus = 'imported' | 'skipped' | 'failed';

export interface ImportRecordResult {
  externalId: string;
  status: ImportRecordStatus;
  midasExpenseId?: string;
  reason?: string;
  error?: string;
}

export interface ImportReport {
  sourceName: string;
  dryRun: boolean;
  totals: { imported: number; skipped: number; failed: number };
  results: ImportRecordResult[];
}

export interface ImportOptions {
  /** When true, validates and reports without writing anything. Default: false. */
  dryRun?: boolean;
}
