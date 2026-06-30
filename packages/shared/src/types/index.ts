export { MIDAS_VERSION } from '../version';

// ── Roles ────────────────────────────────────────────────────────────────────

export type UserRole = 'user' | 'accountant' | 'admin';

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
}

// ── Payment Methods ───────────────────────────────────────────────────────────

export interface PaymentMethod {
  id: string;
  label: string;
  lastFour: string | null;
  brand: string | null;
  zohoAccountName: string | null;
  isActive: boolean;
  isCompanyWide: boolean;
  assignedUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Expense ───────────────────────────────────────────────────────────────────

export type ExpenseStatus = 'draft' | 'pending' | 'in_review' | 'awaiting_info' | 'approved' | 'zoho_sync_failed' | 'rejected';
export type ReimbursementStatus = 'not_requested' | 'pending' | 'approved' | 'paid';

export interface ExpenseCategory {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
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
  status: ExpenseStatus;
  reimbursementStatus: ReimbursementStatus;
  /** Set when an accountant claims the expense via POST /claim */
  reviewedById: string | null;
  reviewedAt: string | null;
  reviewedBy?: Pick<User, 'id' | 'name' | 'email'> | null;
  sourceLabel: string | null;
  sourceUrl: string | null;
  zohoEntity: string | null;
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
  zohoEntity: string;
  categoryName: string | null;
  paymentMethodLabel: string | null;
  brand: string;
}

export interface ZohoReadinessResult {
  ready: boolean;
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
