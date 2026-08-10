/**
 * Pure helpers for PO bulk approve / bulk Zoho push (never-blind UI + server partition).
 */

export type PoBulkRow = {
  id: string;
  type?: string;
  status: string;
  total?: string | number | null;
  zohoEntity?: string | null;
  integrationStatus?: string | null;
  zohoRecordId?: string | null;
  purchaseOrder?: { zohoVendorId?: string | null } | null;
  lineItems?: Array<{ zohoItemId?: string | null }> | null;
  lineItemCount?: number;
};

export type PoApproveFlag =
  | 'awaiting_info'
  | 'no_line_items'
  | 'missing_zoho_vendor'
  | 'missing_zoho_item';

export function poApproveFlags(row: PoBulkRow): PoApproveFlag[] {
  const flags: PoApproveFlag[] = [];
  if (row.status === 'awaiting_info') flags.push('awaiting_info');
  const lineCount = row.lineItemCount ?? row.lineItems?.length ?? 0;
  if (lineCount === 0) flags.push('no_line_items');
  if (!row.purchaseOrder?.zohoVendorId?.trim()) flags.push('missing_zoho_vendor');
  const items = row.lineItems ?? [];
  if (items.length > 0 && items.some((li) => !li.zohoItemId?.trim())) {
    flags.push('missing_zoho_item');
  }
  return flags;
}

/** Statuses the server will approve in bulk (awaiting_info is UI-skipped). */
export function isPoBulkApprovableStatus(status: string): boolean {
  return status === 'submitted' || status === 'in_review';
}

export function partitionPoBulkApprove(
  rows: PoBulkRow[],
  requestedIds: string[],
): { approvable: string[]; skipped: Array<{ id: string; reason: string }> } {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const approvable: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const id of requestedIds) {
    const row = byId.get(id);
    if (!row) {
      skipped.push({ id, reason: 'Not found' });
      continue;
    }
    if (row.type && row.type !== 'purchase_order') {
      skipped.push({ id, reason: 'Not a purchase order' });
      continue;
    }
    if (!isPoBulkApprovableStatus(row.status)) {
      skipped.push({ id, reason: `Status '${row.status}' is not bulk-approvable` });
      continue;
    }
    approvable.push(id);
  }
  return { approvable, skipped };
}

export function isPoReadyForZohoPush(row: PoBulkRow): boolean {
  if (row.zohoRecordId) return false;
  const statusOk = row.status === 'approved' || row.integrationStatus === 'failed';
  if (!statusOk) return false;
  if (!row.zohoEntity?.trim()) return false;
  if (!row.purchaseOrder?.zohoVendorId?.trim()) return false;
  const items = row.lineItems ?? [];
  if (items.length === 0) return false;
  if (items.some((li) => !li.zohoItemId?.trim())) return false;
  return true;
}

export function partitionPoBulkPush(
  rows: PoBulkRow[],
  requestedIds: string[],
): { ready: string[]; skipped: Array<{ id: string; reason: string }> } {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ready: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const id of requestedIds) {
    const row = byId.get(id);
    if (!row) {
      skipped.push({ id, reason: 'Not found' });
      continue;
    }
    if (!isPoReadyForZohoPush(row)) {
      skipped.push({ id, reason: 'Not ready for Zoho push' });
      continue;
    }
    ready.push(id);
  }
  return { ready, skipped };
}
