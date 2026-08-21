export { MIDAS_VERSION } from '../version';
export { groupPaymentMethodsForCompany, patchForCompanyMove } from './paymentMethodGroups';
export {
  categoryDeleteBlocker,
  matchingCategoryIdSet,
  groupCoaByAccount,
  filterCoaAccounts,
} from './categorySettings';
export {
  REFERENCE_NUMBER_MAX,
  normalizeReferenceNumber,
  pickReferenceNumber,
} from './referenceNumber';

// ── Roles ────────────────────────────────────────────────────────────────────

export type UserRole = 'user' | 'accountant' | 'admin' | 'partner' | 'developer';

export interface User {
  id: string;
  /** Identity key — what the user signs in with. */
  username: string;
  /** Optional; required only by email-delivered features (invites, notifications). */
  email: string | null;
  /** Authentik username, set by an admin to pre-link this user to an IdP identity. */
  ssoUsername?: string | null;
  name: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  // ── Org profile (admin console) — present on /admin/users and (defaults) /auth/me ──
  department?: string | null;
  employeeId?: string | null;
  costCenter?: string | null;
  managerId?: string | null;
  /** Default company preselected in the expense wizard. */
  defaultZohoEntity?: string | null;
  /** Default payment method preselected in the expense wizard. */
  defaultPaymentMethodId?: string | null;
  lastLoginAt?: string | null;
}

// ── Companies ────────────────────────────────────────────────────────────────
// The sister companies Midas serves. expenses.zohoEntity stores the company name.

export interface Company {
  id: string;
  name: string;
  /** false = this company never enters the Zoho pipeline (e.g. Summitt Labs). */
  zohoEnabled: boolean;
  isActive?: boolean;
  sortOrder?: number;
}

/** Canonical provenance for expense/transaction source_type. */
export type TransactionSourceType =
  | 'manual'
  | 'online_receipt'
  | 'purchase_order'
  | 'browser_extension'
  | 'trade_show_event'
  | 'import'
  | 'partner'
  | 'other';

export interface Budget {
  id: string;
  companyName: string;
  period: string;
  amount: string;
  categoryId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Payment Methods ───────────────────────────────────────────────────────────

export interface PaymentMethod {
  id: string;
  label: string;
  lastFour: string | null;
  brand: string | null;
  zohoAccountName: string | null;
  /** Default Zoho entity/org when this card is selected (e.g. "Nirvana Kulture"). */
  defaultZohoEntity: string | null;
  /** Personal / out-of-pocket card — expense should enter reimbursement workflow. */
  requiresReimbursement: boolean;
  isActive: boolean;
  isCompanyWide: boolean;
  assignedUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Polymorphic ownership ─────────────────────────────────────────────────────
//
// Midas expenses can belong to an arbitrary external entity (a trade show booth,
// a payroll run, a project, ...) without Midas knowing anything about that
// entity's domain. This is implemented today as `sourceApp` + `sourceRefId` on
// `expenses` (see apps/api/src/db/schema.ts) — those two columns ARE the
// `ownerType` / `ownerId` polymorphic pair; `OwnerRef` below is just the
// embedder-facing name for the same concept. No embedder-specific value
// (e.g. a literal `'trade_show'`) is hardcoded anywhere in Midas — `ownerType`
// is an opaque string chosen by the calling application.
//
// `sourceApp`/`sourceRefId` are kept as the wire/column names for backward
// compatibility; new integrations are encouraged to think in terms of
// `OwnerRef` and use `toOwnerRef` / `fromSourceFields` below.

export interface OwnerRef {
  /** Opaque identifier for the owning application/domain, e.g. 'trade_show', 'argo'. */
  ownerType: string;
  /** Opaque identifier for the specific owning record within that application. */
  ownerId: string;
}

export function toOwnerRef(source: { sourceApp: string | null; sourceRefId: string | null }): OwnerRef | null {
  if (!source.sourceApp || !source.sourceRefId) return null;
  return { ownerType: source.sourceApp, ownerId: source.sourceRefId };
}

export function fromOwnerRef(owner: OwnerRef | null | undefined): { sourceApp: string | null; sourceRefId: string | null } {
  return { sourceApp: owner?.ownerType ?? null, sourceRefId: owner?.ownerId ?? null };
}

// ── Expense ───────────────────────────────────────────────────────────────────

export type ExpenseStatus = 'draft' | 'pending' | 'in_review' | 'awaiting_info' | 'approved' | 'zoho_sync_failed' | 'rejected' | 'cancelled';
export type ReimbursementStatus = 'not_requested' | 'pending' | 'approved' | 'rejected' | 'paid';
export type IntegrationStatus = 'not_required' | 'pending' | 'queued' | 'syncing' | 'synced' | 'failed';
export type TransactionType = 'expense' | 'purchase_order';
export type TransactionStatus = 'draft' | 'submitted' | 'in_review' | 'awaiting_info' | 'approved' | 'rejected' | 'cancelled';

export interface ExpenseCategory {
  id: string;
  name: string;
  description: string | null;
  /** Tree: null = top-level. Arbitrary depth. */
  parentId: string | null;
  isActive: boolean;
}

export interface TransactionLineItem {
  id: string;
  transactionId: string;
  lineNumber: number;
  description: string;
  quantity: string;
  unit: string | null;
  unitPrice: string;
  tax: string;
  total: string;
  zohoItemId: string | null;
  ocrConfidence: string | null;
  needsReview: boolean;
}

export interface PurchaseOrderDetails {
  transactionId: string;
  poNumber: string | null;
  zohoVendorId: string | null;
  deliveryDate: string | null;
  notes: string | null;
}

export interface Transaction {
  id: string;
  type: TransactionType;
  userId: string;
  vendorName: string;
  transactionDate: string;
  currency: string;
  total: string;
  taxTotal: string;
  description: string | null;
  status: TransactionStatus;
  integrationStatus: IntegrationStatus;
  zohoEntity: string | null;
  zohoRecordId: string | null;
  zohoSyncedAt: string | null;
  zohoSyncError?: string | null;
  purchaseOrder?: PurchaseOrderDetails | null;
  lineItems?: TransactionLineItem[];
  user?: Pick<User, 'id' | 'name' | 'email'>;
  createdAt: string;
  updatedAt: string;
}

export interface Expense {
  id: string;
  userId: string;
  categoryId: string | null;
  category?: ExpenseCategory | null;
  paymentMethodId: string | null;
  paymentMethod?: PaymentMethod | null;
  user?: Pick<User, 'id' | 'name' | 'email'>;
  /** 'argo' | 'milo' | 'browser_extension' | null — null means submitted directly via Midas */
  sourceApp: string | null;
  /** Opaque reference ID in the source app */
  sourceRefId: string | null;
  /** Submission context: 'online_receipt' | 'manual' | null */
  sourceType: string | null;
  merchant: string;
  amount: string;
  currency: string;
  date: string;
  description: string | null;
  /** Receipt / invoice / sales-order number sent to Zoho as Reference Number. */
  referenceNumber?: string | null;
  status: ExpenseStatus;
  /** Separate from workflow status — Zoho pipeline. */
  integrationStatus?: IntegrationStatus;
  reimbursementStatus: ReimbursementStatus;
  /** Set when an accountant completes a review action (approve/reject/request info) */
  reviewedById: string | null;
  reviewedAt: string | null;
  reviewedBy?: Pick<User, 'id' | 'name' | 'email'> | null;
  sourceLabel: string | null;
  sourceUrl: string | null;
  zohoEntity: string | null;
  /** Live Zoho Books expense COA account_id (general/daily expenses). */
  zohoExpenseAccountId?: string | null;
  zohoExpenseAccountName?: string | null;
  zohoExpenseId: string | null;
  zohoSyncedAt: string | null;
  /** Last Zoho sync error. Stripped from responses for non-accountant/admin users. */
  zohoSyncError?: string | null;
  receipts?: Receipt[];
  messages?: ExpenseMessage[];
  /** Derived server-side — not stored in DB */
  flags?: string[];
  /** Computed Zoho readiness — derived from flags */
  zohoReady?: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Receipts ──────────────────────────────────────────────────────────────────

export type OcrStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface OcrField {
  value: string | null;
  confidence: number;
  source: 'document_ai' | 'llm' | 'rule_based' | string;
}

export interface Receipt {
  id: string;
  expenseId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  // ── OCR state ──────────────────────────────────────────────────────────────
  ocrStatus: OcrStatus;
  ocrText: string | null;
  // ── OCR enrichment fields (Stage 1: OCR service integration) ───────────────
  /** OCR service request_id — use with OCR admin ledger for cost/provider lookup */
  ocrRequestId: string | null;
  ocrProvider: string | null;
  /** Raw OCR layer confidence (0–1) */
  ocrConfidence: string | null;
  /** Weighted overall confidence across OCR + LLM field extraction (0–1) */
  ocrOverallConfidence: string | null;
  /** True when OCR service flagged this receipt for human review */
  ocrNeedsReview: boolean | null;
  ocrReviewReasons: string[] | null;
  ocrErrorSummary: string | null;
  /** Full OCR result payload; `fields.{merchant,amount,date}.value` prefill the wizard. */
  ocrData?: {
    fields?: {
      merchant?: OcrField;
      amount?: OcrField & { value: number | string | null };
      date?: OcrField;
      /** OCR-suggested expense category — used to preselect the COA account in the wizard. */
      category?: OcrField;
      referenceNumber?: OcrField;
    };
  } | null;
  ocrCostEstimateUsd: string | null;
  ocrSubmittedAt: string | null;
  ocrCompletedAt: string | null;
  uploadedAt: string;
}

// ── Messages ──────────────────────────────────────────────────────────────────

export type MessageRequestType =
  | 'info_request'
  | 'missing_receipt'
  | 'missing_category'
  | 'missing_payment_method'
  | 'general';

export interface ExpenseMessage {
  id: string;
  expenseId: string;
  senderId: string;
  sender?: Pick<User, 'id' | 'name' | 'role'>;
  body: string;
  isSystem: boolean;
  requestType: MessageRequestType | null;
  /** Only present for accountant/admin roles */
  internalNote?: string | null;
  isResolved: boolean;
  resolvedAt: string | null;
  resolvedById: string | null;
  createdAt: string;
}

// ── Captures ──────────────────────────────────────────────────────────────────

export type CaptureSource = 'extension' | 'manual';
export type CaptureStatus = 'draft' | 'linked' | 'discarded';

export interface Capture {
  id: string;
  userId: string;
  expenseId: string | null;
  source: CaptureSource;
  pageUrl: string | null;
  pageTitle: string | null;
  selectedText: string | null;
  imagePath: string;
  status: CaptureStatus;
  createdAt: string;
}

// ── API Payloads ──────────────────────────────────────────────────────────────

export interface CreateExpensePayload {
  merchant: string;
  amount: number;
  currency?: string;
  date: string;
  categoryId?: string;
  paymentMethodId?: string;
  description?: string;
  referenceNumber?: string | null;
  zohoEntity?: string;
  zohoExpenseAccountId?: string;
  zohoExpenseAccountName?: string;
  sourceApp?: string;
  sourceRefId?: string;
}

export interface ReviewExpensePayload {
  action: 'approve' | 'reject' | 'request_info';
  note?: string;
  zohoEntity?: string;
  requestType?: MessageRequestType;
  internalNote?: string;
}

export interface UpdateReimbursementPayload {
  status: ReimbursementStatus;
  note?: string;
}

export interface CreatePaymentMethodPayload {
  label: string;
  lastFour?: string;
  brand?: string;
  zohoAccountName?: string;
  defaultZohoEntity?: string;
  requiresReimbursement?: boolean;
  isCompanyWide?: boolean;
  assignedUserId?: string;
}

// ── Extension capture payload sent from browser extension to API ───────────────

export interface ExtensionCapturePayload {
  imageDataUrl: string;
  pageUrl?: string;
  pageTitle?: string;
}

// ── External app-to-app payload ───────────────────────────────────────────────

export interface ExtCreateExpensePayload extends CreateExpensePayload {
  sourceApp: string;
  sourceRefId: string;
  submitterEmail: string;
}


// ── Zoho readiness (returned by GET /expenses/:id/zoho-readiness) ────────────

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
  checks: ZohoReadinessCheck[];
}

// ── Audit log entry (returned by GET /accountant/expenses/:id/audit) ─────────

export interface AuditLogEntry {
  id: string;
  action: string;
  before: unknown;
  after: unknown;
  metadata: unknown;
  createdAt: string;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
}

// ── Closed accounting periods ─────────────────────────────────────────────────

export interface ClosedPeriod {
  id: string;
  /** 'YYYY-MM' */
  period: string;
  closedById: string | null;
  note: string | null;
  createdAt: string;
  closedBy?: { id: string; name: string } | null;
}

// ── Notifications ─────────────────────────────────────────────────────────────

export type NotificationType = 'action_required' | 'approved' | 'rejected' | 'reimbursement_paid' | 'expense_incomplete';

export interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string | null;
  expenseId: string | null;
  readAt: string | null;
  emailedAt: string | null;
  createdAt: string;
}
