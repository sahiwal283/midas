/** Parses /accountant/queue query params into a normalized filter object. */

export interface QueueFilters {
  status?: string;
  userId?: string;
  search?: string;
  amountMin?: number;
  amountMax?: number;
  from?: string;
  to?: string;
  categoryId?: string;
  paymentMethodId?: string;
  reimbursementStatus?: string;
  zohoStatus?: 'synced' | 'not_synced' | 'sync_failed';
  company?: string;
  sourceApp?: string;
  ocrNeedsReview?: boolean;
  missingReceipt?: boolean;
  missingCategory?: boolean;
  missingPayment?: boolean;
  /** expense | purchase_order — Phase 1 type filter */
  transactionType?: 'expense' | 'purchase_order';
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BOOL_KEYS = ['ocrNeedsReview', 'missingReceipt', 'missingCategory', 'missingPayment'] as const;

export function parseQueueFilters(q: Record<string, string | undefined>): QueueFilters {
  const f: QueueFilters = {};
  if (q.status) f.status = q.status;
  if (q.userId) f.userId = q.userId;
  if (q.search?.trim()) f.search = q.search.trim();
  if (q.amountMin !== undefined && q.amountMin !== '' && Number.isFinite(Number(q.amountMin))) f.amountMin = Number(q.amountMin);
  if (q.amountMax !== undefined && q.amountMax !== '' && Number.isFinite(Number(q.amountMax))) f.amountMax = Number(q.amountMax);
  if (q.from && DATE_RE.test(q.from)) f.from = q.from;
  if (q.to && DATE_RE.test(q.to)) f.to = q.to;
  if (q.categoryId) f.categoryId = q.categoryId;
  if (q.paymentMethodId) f.paymentMethodId = q.paymentMethodId;
  if (q.reimbursementStatus) f.reimbursementStatus = q.reimbursementStatus;
  if (q.zohoStatus === 'synced' || q.zohoStatus === 'not_synced' || q.zohoStatus === 'sync_failed') f.zohoStatus = q.zohoStatus;
  if (q.company) f.company = q.company;
  if (q.sourceApp) f.sourceApp = q.sourceApp;
  if (q.transactionType === 'expense' || q.transactionType === 'purchase_order') {
    f.transactionType = q.transactionType;
  }
  for (const key of BOOL_KEYS) {
    if (q[key] === 'true' || q[key] === '1') f[key] = true;
  }
  return f;
}

export type BulkReviewRow = { id: string; status: string };

/** Safe bulk approval: only pending/in_review are approvable; everything else
 *  is skipped with a reason — never blind-approve. */
export function partitionBulkReview(rows: BulkReviewRow[], requestedIds: string[]): {
  approvable: string[];
  skipped: Array<{ id: string; reason: string }>;
} {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const approvable: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const id of requestedIds) {
    const row = byId.get(id);
    if (!row) {
      skipped.push({ id, reason: 'not found' });
    } else if (row.status === 'pending' || row.status === 'in_review') {
      approvable.push(id);
    } else {
      skipped.push({ id, reason: `not reviewable from status '${row.status}'` });
    }
  }
  return { approvable, skipped };
}
