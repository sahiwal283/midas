import {
  pgTable, pgEnum, uuid, text, timestamp, boolean,
  numeric, date, jsonb, integer, char, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ── Enums ─────────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum('user_role', ['user', 'accountant', 'admin']);
export const expenseStatusEnum = pgEnum('expense_status', [
  'draft', 'pending', 'in_review', 'awaiting_info', 'approved', 'zoho_sync_failed', 'rejected',
]);
export const reimbursementStatusEnum = pgEnum('reimbursement_status', ['not_requested', 'pending', 'approved', 'paid']);
export const ocrStatusEnum = pgEnum('ocr_status', ['pending', 'processing', 'done', 'failed']);
export const captureSourceEnum = pgEnum('capture_source', ['extension', 'manual']);
export const captureStatusEnum = pgEnum('capture_status', ['draft', 'linked', 'discarded']);

// ── Users ─────────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').unique().notNull(),
  name: text('name').notNull(),
  role: userRoleEnum('role').default('user').notNull(),
  passwordHash: text('password_hash').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ── Expense Categories ────────────────────────────────────────────────────────

export const expenseCategories = pgTable('expense_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').unique().notNull(),
  description: text('description'),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── Payment Methods ───────────────────────────────────────────────────────────

export const paymentMethods = pgTable('payment_methods', {
  id: uuid('id').primaryKey().defaultRandom(),
  label: text('label').notNull(),
  lastFour: char('last_four', { length: 4 }),
  brand: text('brand'),
  zohoAccountName: text('zoho_account_name'),
  isActive: boolean('is_active').default(true).notNull(),
  isCompanyWide: boolean('is_company_wide').default(true).notNull(),
  assignedUserId: uuid('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ── Expenses ──────────────────────────────────────────────────────────────────

export const expenses = pgTable('expenses', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }).notNull(),
  categoryId: uuid('category_id').references(() => expenseCategories.id, { onDelete: 'set null' }),
  paymentMethodId: uuid('payment_method_id').references(() => paymentMethods.id, { onDelete: 'set null' }),
  // Null means submitted directly via Midas, not from an external app
  sourceApp: text('source_app'),
  sourceRefId: text('source_ref_id'),
  // Human-readable label for the source context (e.g. "Expo West 2026 — Booth 42")
  sourceLabel: text('source_label'),
  // Deep-link URL back to the source record in the originating app
  sourceUrl: text('source_url'),
  // Classifies the submission context: 'online_receipt' | 'manual' | null
  sourceType: text('source_type'),
  merchant: text('merchant').notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  currency: char('currency', { length: 3 }).default('USD').notNull(),
  date: date('date').notNull(),
  description: text('description'),
  status: expenseStatusEnum('status').default('draft').notNull(),
  reimbursementStatus: reimbursementStatusEnum('reimbursement_status').default('not_requested').notNull(),
  reviewedById: uuid('reviewed_by_id').references(() => users.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at'),
  zohoEntity: text('zoho_entity'),
  zohoExpenseId: text('zoho_expense_id'),
  zohoSyncedAt: timestamp('zoho_synced_at'),
  // Stores the last Zoho sync error message when status = zoho_sync_failed
  zohoSyncError: text('zoho_sync_error'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [
  index('expenses_user_id_idx').on(t.userId),
  index('expenses_status_idx').on(t.status),
  index('expenses_reviewed_by_idx').on(t.reviewedById),
  index('expenses_created_at_idx').on(t.createdAt),
  // Prevents duplicate imports from external apps. Postgres treats (NULL,NULL) as non-equal,
  // so multiple manually-submitted expenses (both cols null) are always allowed.
  uniqueIndex('expenses_source_unique_idx').on(t.sourceApp, t.sourceRefId),
]);

// ── Receipts ──────────────────────────────────────────────────────────────────

export const receipts = pgTable('receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  expenseId: uuid('expense_id').references(() => expenses.id, { onDelete: 'cascade' }).notNull(),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  storagePath: text('storage_path').notNull(),
  // ── OCR state (original) ─────────────────────────────────────────────────
  ocrStatus: ocrStatusEnum('ocr_status').default('pending').notNull(),
  ocrText: text('ocr_text'),
  ocrData: jsonb('ocr_data'),
  // ── OCR enrichment columns (Stage 1: OCR service integration) ────────────
  // Correlates to OCR service request_id for admin ledger lookups.
  ocrRequestId: text('ocr_request_id'),
  ocrProvider: text('ocr_provider'),
  ocrConfidence: numeric('ocr_confidence', { precision: 5, scale: 4 }),
  ocrOverallConfidence: numeric('ocr_overall_confidence', { precision: 5, scale: 4 }),
  ocrNeedsReview: boolean('ocr_needs_review'),
  ocrReviewReasons: text('ocr_review_reasons').array(),
  ocrErrorSummary: text('ocr_error_summary'),
  ocrCostEstimateUsd: numeric('ocr_cost_estimate_usd', { precision: 10, scale: 6 }),
  ocrSubmittedAt: timestamp('ocr_submitted_at'),
  ocrCompletedAt: timestamp('ocr_completed_at'),
  uploadedAt: timestamp('uploaded_at').defaultNow().notNull(),
}, (t) => [
  index('receipts_expense_id_idx').on(t.expenseId),
]);

// ── In-app Expense Conversation ───────────────────────────────────────────────

export const expenseMessages = pgTable('expense_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  expenseId: uuid('expense_id').references(() => expenses.id, { onDelete: 'cascade' }).notNull(),
  senderId: uuid('sender_id').references(() => users.id, { onDelete: 'restrict' }).notNull(),
  body: text('body').notNull(),
  isSystem: boolean('is_system').default(false).notNull(),
  requestType: text('request_type'),       // 'info_request' | 'missing_receipt' | 'missing_category' | 'missing_payment_method' | null
  internalNote: text('internal_note'),     // accountant-only note, not shown to expense owner
  isResolved: boolean('is_resolved').default(false).notNull(),
  resolvedAt: timestamp('resolved_at'),
  resolvedById: uuid('resolved_by_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('expense_messages_expense_id_idx').on(t.expenseId),
]);

// ── Extension Captures ────────────────────────────────────────────────────────

export const captures = pgTable('captures', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }).notNull(),
  expenseId: uuid('expense_id').references(() => expenses.id, { onDelete: 'set null' }),
  source: captureSourceEnum('source').default('extension').notNull(),
  pageUrl: text('page_url'),
  pageTitle: text('page_title'),
  selectedText: text('selected_text'),
  imagePath: text('image_path').notNull(),
  status: captureStatusEnum('status').default('draft').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('captures_user_id_idx').on(t.userId),
  index('captures_expense_id_idx').on(t.expenseId),
]);

// ── Audit Log ─────────────────────────────────────────────────────────────────

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  before: jsonb('before'),
  after: jsonb('after'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('audit_logs_entity_idx').on(t.entityType, t.entityId),
  index('audit_logs_created_at_idx').on(t.createdAt),
]);

// ── App-to-App Connections ────────────────────────────────────────────────────

export const appConnections = pgTable('app_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  appName: text('app_name').unique().notNull(),
  apiKeyHash: text('api_key_hash').notNull(),
  permissions: jsonb('permissions').$type<string[]>().default([]).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at'),
});

// ── Relations ─────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  expenses: many(expenses),
  messages: many(expenseMessages),
  captures: many(captures),
  paymentMethods: many(paymentMethods),
}));

export const paymentMethodsRelations = relations(paymentMethods, ({ one }) => ({
  assignedUser: one(users, { fields: [paymentMethods.assignedUserId], references: [users.id] }),
}));

export const expensesRelations = relations(expenses, ({ one, many }) => ({
  user: one(users, { fields: [expenses.userId], references: [users.id] }),
  reviewedBy: one(users, { fields: [expenses.reviewedById], references: [users.id] }),
  category: one(expenseCategories, { fields: [expenses.categoryId], references: [expenseCategories.id] }),
  paymentMethod: one(paymentMethods, { fields: [expenses.paymentMethodId], references: [paymentMethods.id] }),
  receipts: many(receipts),
  messages: many(expenseMessages),
  captures: many(captures),
}));

export const receiptsRelations = relations(receipts, ({ one }) => ({
  expense: one(expenses, { fields: [receipts.expenseId], references: [expenses.id] }),
}));

export const expenseMessagesRelations = relations(expenseMessages, ({ one }) => ({
  expense: one(expenses, { fields: [expenseMessages.expenseId], references: [expenses.id] }),
  sender: one(users, { fields: [expenseMessages.senderId], references: [users.id] }),
}));

export const capturesRelations = relations(captures, ({ one }) => ({
  user: one(users, { fields: [captures.userId], references: [users.id] }),
  expense: one(expenses, { fields: [captures.expenseId], references: [expenses.id] }),
}));
