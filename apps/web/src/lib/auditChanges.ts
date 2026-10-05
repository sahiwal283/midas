/**
 * Turns an expense audit entry into something a reader can scan: a label for
 * the action and, for field corrections, one "Notes: a → b" line per field.
 * Pure, so the Recent Activity card stays a renderer.
 */

export interface AuditChangeLine {
  field: string;
  before: string;
  after: string;
}

interface AuditEntryLike {
  action: string;
  before: unknown;
  after: unknown;
  metadata: unknown;
}

interface AuditTrailEntryLike extends AuditEntryLike {
  createdAt: string;
  actorName: string | null;
}

export interface NoteEdit {
  actorName: string | null;
  createdAt: string;
}

const ACTION_LABELS: Record<string, string> = {
  'review.claimed': 'Claimed for review',
  'review.released': 'Claim released',
  'review.approve': 'Approved',
  'review.reject': 'Rejected',
  'review.request_info': 'Info requested',
  'info_request_resolved': 'Requests resolved',
  'reimbursement.updated': 'Reimbursement updated',
  'category.updated': 'Category updated',
  'details.corrected': 'Details corrected',
  'reference_number.set': 'Reference number set',
  'zoho.pushed': 'Pushed to Zoho',
  'zoho.failed': 'Zoho push failed',
  'zoho_entity.set': 'Company set',
  'submitted': 'Submitted for review',
  'created': 'Expense created',
  'updated': 'Fields updated',
  'uploaded': 'Receipt uploaded',
  'user_responded': 'Employee replied',
  'receipt_attached_from_extension': 'Receipt attached (extension)',
  'expense_created_from_extension': 'Created via extension',
  'ext.created': 'Created via app API',
  'capture_linked_to_expense': 'Screenshot linked',
};

/** Column → the label the detail cards use for it. Unlisted columns are internal and skipped. */
const FIELD_LABELS: Record<string, string> = {
  description: 'Notes',
  merchant: 'Merchant',
  amount: 'Amount',
  date: 'Date',
  zohoEntity: 'Company',
  paymentMethodId: 'Payment method',
  referenceNumber: 'Reference number',
  categoryId: 'Category',
  zohoExpenseAccountName: 'Expense account',
  sourceLabel: 'Event',
  reimbursementStatus: 'Reimbursement',
};

export function auditActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function isFlatObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function show(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function auditChanges(entry: AuditEntryLike): AuditChangeLine[] {
  const { before, after } = entry;
  if (!isFlatObject(before) || !isFlatObject(after)) return [];
  const lines: AuditChangeLine[] = [];
  for (const key of Object.keys(after)) {
    const label = FIELD_LABELS[key];
    if (!label) continue;
    // zohoExpenseAccountName rides along with a company or category change and
    // only means something when the reader can see what it was before.
    if (key === 'zohoExpenseAccountName' && !(key in before)) continue;
    lines.push({ field: label, before: show(before[key]), after: show(after[key]) });
  }
  return lines;
}

/** True when the entry records a change made in Midas that, by design, was not sent on to Zoho. */
export function auditMidasOnly(entry: AuditEntryLike): boolean {
  return isFlatObject(entry.metadata) && entry.metadata.midasOnly === true;
}

/**
 * Who last changed the notes and when, or null if nobody has. Expects the
 * trail newest-first, as the audit endpoint returns it. Only the two actions
 * that write the note count: an accountant correction and the owner's own edit.
 */
export function latestNoteEdit(entries: AuditTrailEntryLike[]): NoteEdit | null {
  for (const entry of entries) {
    if (entry.action !== 'details.corrected' && entry.action !== 'updated') continue;
    if (!isFlatObject(entry.after) || !('description' in entry.after)) continue;
    // The owner's edit logs the whole row on both sides; only a note that
    // actually differs counts as a note edit.
    if (isFlatObject(entry.before) && 'description' in entry.before
      && (entry.before.description ?? null) === (entry.after.description ?? null)) continue;
    return { actorName: entry.actorName, createdAt: entry.createdAt };
  }
  return null;
}
