import {
  pgTable, pgEnum, uuid, text, timestamp, boolean,
  numeric, date, jsonb, integer, char, index, uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

/** Opaque embedder context (e.g. eventId, location, cardUsed). App-agnostic. */
export type ExpenseSourceContext = {
  eventId?: string;
  eventName?: string;
  location?: string | null;
  cardUsed?: string | null;
  externalUserId?: string;
  [key: string]: unknown;
};

// ── Enums ─────────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum('user_role', ['user', 'accountant', 'admin', 'partner', 'developer']);
export const expenseStatusEnum = pgEnum('expense_status', [
  // zoho_sync_failed kept for DB/API compat; new writes use approved + integration_status=failed
  'draft', 'pending', 'in_review', 'awaiting_info', 'approved', 'zoho_sync_failed', 'rejected', 'cancelled',
]);
export const reimbursementStatusEnum = pgEnum('reimbursement_status', [
  'not_requested', 'pending', 'approved', 'rejected', 'paid',
]);
export const ocrStatusEnum = pgEnum('ocr_status', ['pending', 'processing', 'done', 'failed']);
export const captureSourceEnum = pgEnum('capture_source', ['extension', 'manual']);
export const partnerExpenseCategoryEnum = pgEnum('partner_expense_category', ['business', 'personal']);
export const expenseKindEnum = pgEnum('expense_kind', ['business', 'partner']);
export const captureStatusEnum = pgEnum('capture_status', ['draft', 'linked', 'discarded']);

/** Shared financial root: expense | purchase_order */
export const transactionTypeEnum = pgEnum('transaction_type', ['expense', 'purchase_order']);
export const transactionStatusEnum = pgEnum('transaction_status', [
  'draft', 'submitted', 'in_review', 'awaiting_info', 'approved', 'rejected', 'cancelled',
]);
export const integrationStatusEnum = pgEnum('integration_status', [
  'not_required', 'pending', 'queued', 'syncing', 'synced', 'failed',
]);

// ── Users ─────────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /**
   * Identity key. Stored lowercase and unique. Username — not email — is what a
   * user signs in with and what SSO auto-provisioning needs, so an Authentik
   * account with no email address can still be onboarded.
   */
  username: text('username').unique().notNull(),
  /**
   * Optional. Postgres allows many NULLs in a unique index, so several users may
   * have no email while the emails that do exist stay unique. Required only by
   * features that actually deliver mail (invites, notification email).
   */
  email: text('email').unique(),
  /**
   * Authentik username, set by an admin to pre-link this Midas user to an IdP
   * identity before their first SSO login. Checked ahead of username/email
   * matching so linking never depends on those happening to agree.
   */
  ssoUsername: text('sso_username'),
  name: text('name').notNull(),
  role: userRoleEnum('role').default('user').notNull(),
  passwordHash: text('password_hash'),
  isActive: boolean('is_active').default(true).notNull(),
  // ── Org profile (admin console) ────────────────────────────────────────────
  department: text('department'),
  employeeId: text('employee_id'),
  costCenter: text('cost_center'),
  managerId: uuid('manager_id'),
  /** Default company for the expense wizard. */
  defaultZohoEntity: text('default_zoho_entity'),
  defaultPaymentMethodId: uuid('default_payment_method_id'),
  lastLoginAt: timestamp('last_login_at'),
  // ── Invitation (single-use, 7-day) ─────────────────────────────────────────
  inviteToken: text('invite_token'),
  inviteExpiresAt: timestamp('invite_expires_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ── Alternate / retired emails ────────────────────────────────────────────────
// External systems keep sending an address after a merge or an email change.
// These resolve to the owning user so their submissions are never orphaned.

export const userEmailAliases = pgTable('user_email_aliases', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  email: text('email').notNull(),
  note: text('note'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('user_email_aliases_email_idx').on(t.email),
  index('user_email_aliases_user_idx').on(t.userId),
]);

// ── Expense Categories ────────────────────────────────────────────────────────

export const expenseCategories = pgTable('expense_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').unique().notNull(),
  description: text('description'),
  /** Zoho Books expense (COA) account_id for create_books. */
  zohoAccountId: text('zoho_account_id'),
  /** Tree: null = top-level. Arbitrary depth; cycles rejected at the API layer. */
  parentId: uuid('parent_id').references((): AnyPgColumn => expenseCategories.id, { onDelete: 'set null' }),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── Payment Methods ───────────────────────────────────────────────────────────

export const paymentMethods = pgTable('payment_methods', {
  id: uuid('id').primaryKey().defaultRandom(),
  label: text('label').notNull(),
  lastFour: char('last_four', { length: 4 }),
  brand: text('brand'),
  /** Zoho Books "paid through" account name or account id (Trade Show zohoPaymentAccountId). */
  zohoAccountName: text('zoho_account_name'),
  /** Default Zoho Books org/entity when this card is selected (Trade Show card.entity). */
  defaultZohoEntity: text('default_zoho_entity'),
  /** True for personal / out-of-pocket cards that need employee reimbursement. */
  requiresReimbursement: boolean('requires_reimbursement').default(false).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  isCompanyWide: boolean('is_company_wide').default(true).notNull(),
  assignedUserId: uuid('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ── Companies ─────────────────────────────────────────────────────────────────
// The sister companies Midas serves. expenses.zoho_entity stores the company
// NAME. zoho_enabled=false companies never enter the Zoho pipeline.

export const companies = pgTable('companies', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').unique().notNull(),
  zohoEnabled: boolean('zoho_enabled').default(true).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** Monthly spend budgets per company (and optional expense category). */
export const budgets = pgTable('budgets', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyName: text('company_name').references(() => companies.name, { onDelete: 'restrict', onUpdate: 'cascade' }).notNull(),
  /** YYYY-MM */
  period: char('period', { length: 7 }).notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  categoryId: uuid('category_id').references(() => expenseCategories.id, { onDelete: 'set null' }),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [
  index('budgets_period_idx').on(t.period),
  index('budgets_company_idx').on(t.companyName),
]);

// ── Per-company Zoho COA account per category ─────────────────────────────────
// Trade Show parity: each category maps to a different Zoho Books expense
// account per sister company (expenses.zoho_entity stores the company NAME).

export const categoryZohoAccounts = pgTable('category_zoho_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  categoryId: uuid('category_id').references(() => expenseCategories.id, { onDelete: 'cascade' }).notNull(),
  companyName: text('company_name').references(() => companies.name, { onDelete: 'restrict', onUpdate: 'cascade' }).notNull(),
  zohoAccountId: text('zoho_account_id').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('category_zoho_accounts_cat_company_idx').on(t.categoryId, t.companyName),
]);

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
  // Open vocabulary: 'online_receipt' | 'manual' | 'trade_show_event' | …
  sourceType: text('source_type'),
  /**
   * 'partner' marks personal/partner spend: tracked and charted, but excluded
   * from the accountant queue and the Zoho pipeline. Set only by partner-role
   * submitters; the API coerces everyone else to 'business'.
   */
  expenseKind: expenseKindEnum('expense_kind').default('business').notNull(),
  // Opaque embedder context — eventId, location, cardUsed, etc. (no app-specific columns)
  sourceContext: jsonb('source_context').$type<ExpenseSourceContext>().default({}).notNull(),
  // Embedder's user id (e.g. Trade Show users.id) — filterable independently of Midas userId
  externalUserId: text('external_user_id'),
  merchant: text('merchant').notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  currency: char('currency', { length: 3 }).default('USD').notNull(),
  date: date('date').notNull(),
  description: text('description'),
  status: expenseStatusEnum('status').default('draft').notNull(),
  /** Zoho/integration pipeline — separate from workflow status. */
  integrationStatus: integrationStatusEnum('integration_status').default('not_required').notNull(),
  reimbursementStatus: reimbursementStatusEnum('reimbursement_status').default('not_requested').notNull(),
  reviewedById: uuid('reviewed_by_id').references(() => users.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at'),
  zohoEntity: text('zoho_entity'),
  /** Zoho Books expense COA account_id selected from live chart of accounts. */
  zohoExpenseAccountId: text('zoho_expense_account_id'),
  /** Display name for zohoExpenseAccountId (e.g. "Meals"). */
  zohoExpenseAccountName: text('zoho_expense_account_name'),
  zohoExpenseId: text('zoho_expense_id'),
  zohoSyncedAt: timestamp('zoho_synced_at'),
  // Stores the last Zoho sync error message when status = zoho_sync_failed
  zohoSyncError: text('zoho_sync_error'),
  zohoRequestId: text('zoho_request_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [
  index('expenses_user_id_idx').on(t.userId),
  index('expenses_status_idx').on(t.status),
  index('expenses_reviewed_by_idx').on(t.reviewedById),
  index('expenses_created_at_idx').on(t.createdAt),
  index('expenses_source_app_idx').on(t.sourceApp),
  index('expenses_external_user_id_idx').on(t.externalUserId),
  index('expenses_source_context_event_id_idx').using(
    'btree',
    sql`(${t.sourceContext}->>'eventId')`,
  ),
  // Prevents duplicate imports from external apps. Postgres treats (NULL,NULL) as non-equal,
  // so multiple manually-submitted expenses (both cols null) are always allowed.
  uniqueIndex('expenses_source_unique_idx').on(t.sourceApp, t.sourceRefId),
]);

// ── Vendors (first-class; POs + expense merchant matching) ────────────────────

export const vendors = pgTable('vendors', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  normalizedName: text('normalized_name').notNull(),
  zohoVendorId: text('zoho_vendor_id'),
  defaultEntity: text('default_entity'),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('vendors_normalized_name_idx').on(t.normalizedName),
  index('vendors_zoho_vendor_id_idx').on(t.zohoVendorId),
]);

// ── Zoho items cache (PO line-item matching) ──────────────────────────────────

export const zohoItems = pgTable('zoho_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  zohoItemId: text('zoho_item_id').notNull(),
  name: text('name').notNull(),
  sku: text('sku'),
  unit: text('unit'),
  brand: text('brand').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  syncedAt: timestamp('synced_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('zoho_items_brand_zoho_id_idx').on(t.brand, t.zohoItemId),
  index('zoho_items_name_idx').on(t.name),
]);

// ── Transactions (shared financial root) ──────────────────────────────────────

export const transactions = pgTable('transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: transactionTypeEnum('type').notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }).notNull(),
  vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'set null' }),
  /** Display / OCR vendor or merchant string. */
  vendorName: text('vendor_name').notNull(),
  transactionDate: date('transaction_date').notNull(),
  currency: char('currency', { length: 3 }).default('USD').notNull(),
  total: numeric('total', { precision: 12, scale: 2 }).notNull(),
  taxTotal: numeric('tax_total', { precision: 12, scale: 2 }).default('0').notNull(),
  description: text('description'),
  status: transactionStatusEnum('status').default('draft').notNull(),
  integrationStatus: integrationStatusEnum('integration_status').default('not_required').notNull(),
  sourceApp: text('source_app'),
  sourceRefId: text('source_ref_id'),
  sourceLabel: text('source_label'),
  sourceUrl: text('source_url'),
  sourceType: text('source_type'),
  sourceContext: jsonb('source_context').$type<ExpenseSourceContext>().default({}).notNull(),
  externalUserId: text('external_user_id'),
  zohoEntity: text('zoho_entity'),
  zohoRecordId: text('zoho_record_id'),
  zohoSyncedAt: timestamp('zoho_synced_at'),
  zohoSyncError: text('zoho_sync_error'),
  zohoRequestId: text('zoho_request_id'),
  reviewedById: uuid('reviewed_by_id').references(() => users.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [
  index('transactions_user_id_idx').on(t.userId),
  index('transactions_type_idx').on(t.type),
  index('transactions_status_idx').on(t.status),
  index('transactions_integration_status_idx').on(t.integrationStatus),
  index('transactions_created_at_idx').on(t.createdAt),
  index('transactions_vendor_id_idx').on(t.vendorId),
  uniqueIndex('transactions_source_unique_idx').on(t.sourceApp, t.sourceRefId),
]);

export const expenseDetails = pgTable('expense_details', {
  transactionId: uuid('transaction_id').primaryKey().references(() => transactions.id, { onDelete: 'cascade' }),
  categoryId: uuid('category_id').references(() => expenseCategories.id, { onDelete: 'set null' }),
  paymentMethodId: uuid('payment_method_id').references(() => paymentMethods.id, { onDelete: 'set null' }),
  reimbursementStatus: reimbursementStatusEnum('reimbursement_status').default('not_requested').notNull(),
  zohoExpenseAccountId: text('zoho_expense_account_id'),
  zohoExpenseAccountName: text('zoho_expense_account_name'),
});

export const purchaseOrders = pgTable('purchase_orders', {
  transactionId: uuid('transaction_id').primaryKey().references(() => transactions.id, { onDelete: 'cascade' }),
  poNumber: text('po_number'),
  zohoVendorId: text('zoho_vendor_id'),
  deliveryDate: date('delivery_date'),
  notes: text('notes'),
});

export const transactionLineItems = pgTable('transaction_line_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  transactionId: uuid('transaction_id').references(() => transactions.id, { onDelete: 'cascade' }).notNull(),
  lineNumber: integer('line_number').notNull(),
  itemId: uuid('item_id').references(() => zohoItems.id, { onDelete: 'set null' }),
  zohoItemId: text('zoho_item_id'),
  description: text('description').notNull(),
  quantity: numeric('quantity', { precision: 14, scale: 4 }).notNull(),
  unit: text('unit'),
  unitPrice: numeric('unit_price', { precision: 12, scale: 4 }).notNull(),
  tax: numeric('tax', { precision: 12, scale: 2 }).default('0').notNull(),
  total: numeric('total', { precision: 12, scale: 2 }).notNull(),
  ocrConfidence: numeric('ocr_confidence', { precision: 5, scale: 4 }),
  needsReview: boolean('needs_review').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [
  index('transaction_line_items_tx_idx').on(t.transactionId),
  uniqueIndex('transaction_line_items_tx_line_idx').on(t.transactionId, t.lineNumber),
]);

// ── Receipts ──────────────────────────────────────────────────────────────────

export const receipts = pgTable('receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  expenseId: uuid('expense_id').references(() => expenses.id, { onDelete: 'cascade' }).notNull(),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  storagePath: text('storage_path').notNull(),
  sha256: text('sha256'),
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

// ── Closed Accounting Periods ─────────────────────────────────────────────────
// A closed month ('YYYY-MM') locks every expense dated in it: no edits,
// deletes, submits, reviews, or reimbursement changes (admin force-delete is
// the audited override). Reopen by deleting the row (admin only).

export const closedPeriods = pgTable('closed_periods', {
  id: uuid('id').primaryKey().defaultRandom(),
  period: char('period', { length: 7 }).unique().notNull(),
  closedById: uuid('closed_by_id').references(() => users.id, { onDelete: 'set null' }),
  note: text('note'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

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

// ── SSO Identity Links ────────────────────────────────────────────────────────

export const ssoLinks = pgTable('sso_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').notNull(),      // 'authentik'
  subject: text('subject').notNull(),        // OIDC sub claim
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  linkedAt: timestamp('linked_at').defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at'),
  metadata: jsonb('metadata'),
}, (t) => [
  uniqueIndex('sso_links_provider_subject_idx').on(t.provider, t.subject),
  index('sso_links_user_id_idx').on(t.userId),
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

// ── Per-connection category vocabulary ────────────────────────────────────────
// Which Midas categories a consuming app may see via GET /ext/categories.
// A connection with NO rows here is unrestricted (sees every active category),
// so existing integrations keep working until someone opts them in.
// Midas stays app-agnostic: the vocabulary is data, never hardcoded names.

export const appConnectionCategories = pgTable('app_connection_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').references(() => appConnections.id, { onDelete: 'cascade' }).notNull(),
  categoryId: uuid('category_id').references(() => expenseCategories.id, { onDelete: 'cascade' }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('app_connection_categories_conn_cat_idx').on(t.connectionId, t.categoryId),
  index('app_connection_categories_conn_idx').on(t.connectionId),
]);

// ── Category mappings (OCR / legacy suggestion → categoryId per sourceApp) ────

export const categoryMappings = pgTable('category_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceApp: text('source_app').notNull(),
  suggestion: text('suggestion').notNull(),
  categoryId: uuid('category_id').references(() => expenseCategories.id, { onDelete: 'cascade' }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('category_mappings_source_suggestion_idx').on(t.sourceApp, t.suggestion),
  index('category_mappings_category_id_idx').on(t.categoryId),
]);

// ── Partner Expenses ──────────────────────────────────────────────────────────
// Standalone tracker for partner-related spend. Deliberately decoupled from the
// normal expense flow: no receipts, no review queue, no reimbursement, no Zoho.

export const partnerExpenses = pgTable('partner_expenses', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }).notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  itemLocation: text('item_location').notNull(),
  category: partnerExpenseCategoryEnum('category').default('business').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── Notifications ─────────────────────────────────────────────────────────────
// In-app notification feed. Email delivery is best-effort (emailed_at on success).

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  /** 'action_required' | 'approved' | 'rejected' | 'reimbursement_paid' */
  type: text('type').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  expenseId: uuid('expense_id').references(() => expenses.id, { onDelete: 'cascade' }),
  readAt: timestamp('read_at'),
  emailedAt: timestamp('emailed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('notifications_user_id_idx').on(t.userId),
]);

// ── Relations ─────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  expenses: many(expenses),
  messages: many(expenseMessages),
  captures: many(captures),
  paymentMethods: many(paymentMethods),
  ssoLinks: many(ssoLinks),
}));

export const ssoLinksRelations = relations(ssoLinks, ({ one }) => ({
  user: one(users, { fields: [ssoLinks.userId], references: [users.id] }),
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

export const closedPeriodsRelations = relations(closedPeriods, ({ one }) => ({
  closedBy: one(users, { fields: [closedPeriods.closedById], references: [users.id] }),
}));

export const partnerExpensesRelations = relations(partnerExpenses, ({ one }) => ({
  user: one(users, { fields: [partnerExpenses.userId], references: [users.id] }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
  expense: one(expenses, { fields: [notifications.expenseId], references: [expenses.id] }),
}));

export const vendorsRelations = relations(vendors, ({ many }) => ({
  transactions: many(transactions),
}));

export const budgetsRelations = relations(budgets, ({ one }) => ({
  company: one(companies, { fields: [budgets.companyName], references: [companies.name] }),
  category: one(expenseCategories, { fields: [budgets.categoryId], references: [expenseCategories.id] }),
}));

export const transactionsRelations = relations(transactions, ({ one, many }) => ({
  user: one(users, { fields: [transactions.userId], references: [users.id] }),
  vendor: one(vendors, { fields: [transactions.vendorId], references: [vendors.id] }),
  reviewedBy: one(users, { fields: [transactions.reviewedById], references: [users.id] }),
  expenseDetails: one(expenseDetails),
  purchaseOrder: one(purchaseOrders),
  lineItems: many(transactionLineItems),
}));

export const expenseDetailsRelations = relations(expenseDetails, ({ one }) => ({
  transaction: one(transactions, { fields: [expenseDetails.transactionId], references: [transactions.id] }),
  category: one(expenseCategories, { fields: [expenseDetails.categoryId], references: [expenseCategories.id] }),
  paymentMethod: one(paymentMethods, { fields: [expenseDetails.paymentMethodId], references: [paymentMethods.id] }),
}));

export const purchaseOrdersRelations = relations(purchaseOrders, ({ one }) => ({
  transaction: one(transactions, { fields: [purchaseOrders.transactionId], references: [transactions.id] }),
}));

export const transactionLineItemsRelations = relations(transactionLineItems, ({ one }) => ({
  transaction: one(transactions, { fields: [transactionLineItems.transactionId], references: [transactions.id] }),
  item: one(zohoItems, { fields: [transactionLineItems.itemId], references: [zohoItems.id] }),
}));

export const zohoItemsRelations = relations(zohoItems, ({ many }) => ({
  lineItems: many(transactionLineItems),
}));
