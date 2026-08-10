import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { accountantApi } from '../api/expenses';
import { ZohoErrorCategoryChip } from '../components/ZohoSyncCard';

type PoLine = { zohoItemId?: string | null };
type PoRow = {
  id: string;
  vendorName: string;
  transactionDate: string;
  total: string;
  status: string;
  integrationStatus: string;
  zohoEntity?: string | null;
  zohoRecordId?: string | null;
  zohoSyncError?: string | null;
  poNumber?: string | null;
  lineItemCount?: number;
  lineItems?: PoLine[];
  purchaseOrder?: { zohoVendorId?: string | null; poNumber?: string | null } | null;
  user?: { name: string };
};

function fmtMoney(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

type Flag = 'awaiting_info' | 'no_line_items' | 'missing_zoho_vendor' | 'missing_zoho_item';

function poFlags(row: PoRow): Flag[] {
  const flags: Flag[] = [];
  if (row.status === 'awaiting_info') flags.push('awaiting_info');
  const lineCount = row.lineItemCount ?? row.lineItems?.length ?? 0;
  if (lineCount === 0) flags.push('no_line_items');
  if (!row.purchaseOrder?.zohoVendorId?.trim()) flags.push('missing_zoho_vendor');
  const items = row.lineItems ?? [];
  if (items.length > 0 && items.some((li) => !li.zohoItemId?.trim())) flags.push('missing_zoho_item');
  return flags;
}

function canBulkApproveStatus(status: string): boolean {
  return status === 'submitted' || status === 'in_review';
}

function isReadyForPush(row: PoRow): boolean {
  if (row.zohoRecordId) return false;
  if (!(row.status === 'approved' || row.integrationStatus === 'failed')) return false;
  if (!row.zohoEntity?.trim()) return false;
  if (!row.purchaseOrder?.zohoVendorId?.trim()) return false;
  const items = row.lineItems ?? [];
  if (items.length === 0) return false;
  if (items.some((li) => !li.zohoItemId?.trim())) return false;
  return true;
}

export function PurchaseOrderQueue() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showApproveModal, setShowApproveModal] = useState(false);
  const [pushSummary, setPushSummary] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['accountant-pos'],
    queryFn: () => accountantApi.purchaseOrders() as Promise<PoRow[]>,
  });

  const rows = q.data ?? [];
  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);

  const bulkApprove = useMutation({
    mutationFn: ({ ids }: { ids: string[]; flaggedCount: number }) => accountantApi.bulkPoReview(ids),
    onSuccess: (result, variables) => {
      setShowApproveModal(false);
      setSelected(new Set());
      const skippedTotal = result.skipped.length + variables.flaggedCount;
      setPushSummary(
        `Approved ${result.approved.length}` +
          (skippedTotal > 0 ? ` · skipped ${skippedTotal}` : ''),
      );
      void qc.invalidateQueries({ queryKey: ['accountant-pos'] });
    },
  });

  const bulkPush = useMutation({
    mutationFn: (ids: string[]) => accountantApi.bulkPoZohoPush(ids),
    onSuccess: (result) => {
      setSelected(new Set());
      setPushSummary(
        `Pushed ${result.pushed.length} to Zoho` +
          (result.failed.length > 0 ? ` · ${result.failed.length} need attention` : ''),
      );
      void qc.invalidateQueries({ queryKey: ['accountant-pos'] });
    },
  });

  const pushOne = useMutation({
    mutationFn: (id: string) => accountantApi.pushPurchaseOrder(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['accountant-pos'] }),
  });

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (rows.length > 0 && rows.every((r) => selected.has(r.id))) {
      setSelected(new Set());
    } else {
      setSelected(new Set(rows.map((r) => r.id)));
    }
  }

  const readyToPushIds = selectedRows.filter(isReadyForPush).map((r) => r.id);
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <div className="p-4 lg:p-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link to="/accountant" className="text-sm font-medium text-brand-700 hover:text-brand-800">
            ← Expense queue
          </Link>
          <h1 className="mt-1 font-display text-3xl font-semibold text-ink">Purchase Order Queue</h1>
          <p className="mt-1 text-sm text-charcoal/55">
            Review submitted POs and push approved ones to Zoho Books.
          </p>
        </div>
        <Link
          to="/transactions/po/new"
          className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-cream hover:bg-brand-600"
        >
          New PO
        </Link>
      </div>

      {pushSummary && (
        <div className="mb-4 rounded-lg border border-brand-500/25 bg-brand-500/10 px-4 py-2 text-sm text-ink">
          {pushSummary}
          <button type="button" className="ml-3 text-xs font-medium text-brand-700 underline" onClick={() => setPushSummary(null)}>
            Dismiss
          </button>
        </div>
      )}

      {selected.size > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-ink/10 bg-white px-4 py-3 shadow-panel">
          <span className="text-sm font-medium text-ink">{selected.size} selected</span>
          <button
            type="button"
            onClick={() => setShowApproveModal(true)}
            className="rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-semibold text-cream hover:bg-brand-600"
          >
            Bulk approve…
          </button>
          <button
            type="button"
            disabled={readyToPushIds.length === 0 || bulkPush.isPending}
            onClick={() => bulkPush.mutate(readyToPushIds)}
            className="rounded-lg border border-success/30 bg-success/10 px-3 py-1.5 text-xs font-semibold text-success hover:bg-success/15 disabled:opacity-50"
          >
            {bulkPush.isPending ? 'Pushing…' : `Push ${readyToPushIds.length} to Zoho`}
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="text-xs font-medium text-charcoal/50 hover:text-ink"
          >
            Clear
          </button>
        </div>
      )}

      <div className="rounded-xl border border-ink/10 bg-white shadow-panel">
        {q.isLoading ? (
          <p className="px-6 py-12 text-center text-sm text-charcoal/40">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="px-6 py-12 text-center text-sm text-charcoal/45">No purchase orders in review.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink/10 text-left text-xs font-semibold uppercase tracking-wider text-charcoal/45">
                <th className="px-4 py-3">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" />
                </th>
                <th className="px-5 py-3">Vendor</th>
                <th className="px-5 py-3">Date</th>
                <th className="px-5 py-3">PO #</th>
                <th className="px-5 py-3 text-right">Total</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Zoho</th>
                <th className="px-5 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {rows.map((po) => {
                const canPush = isReadyForPush(po);
                return (
                  <tr key={po.id} className="hover:bg-ink/[0.02]">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(po.id)}
                        onChange={() => toggle(po.id)}
                        aria-label={`Select ${po.vendorName}`}
                      />
                    </td>
                    <td className="px-5 py-3">
                      <Link to={`/transactions/${po.id}`} className="font-medium text-ink hover:text-brand-700">
                        {po.vendorName}
                      </Link>
                      <p className="text-xs text-charcoal/40">
                        {po.user?.name ?? '—'} · {po.lineItemCount ?? 0} lines
                      </p>
                    </td>
                    <td className="px-5 py-3 text-charcoal/70">{po.transactionDate}</td>
                    <td className="px-5 py-3 text-charcoal/70">{po.poNumber ?? '—'}</td>
                    <td className="px-5 py-3 text-right font-medium text-ink">${Number(po.total).toFixed(2)}</td>
                    <td className="px-5 py-3 text-xs uppercase tracking-wide text-charcoal/60">{po.status}</td>
                    <td className="px-5 py-3 text-xs text-charcoal/50">
                      {po.zohoRecordId ? (
                        <span className="font-mono text-success">{po.zohoRecordId}</span>
                      ) : (
                        <div className="flex flex-col items-start gap-1">
                          <span>
                            {po.integrationStatus}
                            {po.zohoSyncError ? ` — ${po.zohoSyncError.replace(/^\[[A-Z_]+\]\s*/, '')}` : ''}
                          </span>
                          <ZohoErrorCategoryChip error={po.zohoSyncError} />
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {canPush && (
                        <button
                          type="button"
                          disabled={pushOne.isPending}
                          onClick={() => pushOne.mutate(po.id)}
                          className="rounded-lg border border-success/30 bg-success/10 px-2.5 py-1 text-xs font-semibold text-success hover:bg-success/15 disabled:opacity-50"
                        >
                          Push Zoho
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showApproveModal && (
        <BulkPoApproveModal
          rows={selectedRows}
          isPending={bulkApprove.isPending}
          onCancel={() => setShowApproveModal(false)}
          onConfirm={(readyIds, flaggedCount) =>
            bulkApprove.mutate({ ids: readyIds, flaggedCount })
          }
        />
      )}
    </div>
  );
}

function BulkPoApproveModal({
  rows,
  isPending,
  onCancel,
  onConfirm,
}: {
  rows: PoRow[];
  isPending: boolean;
  onCancel: () => void;
  onConfirm: (readyIds: string[], flaggedCount: number) => void;
}) {
  const total = rows.reduce((sum, e) => sum + Number(e.total || 0), 0);

  const flaggedIds = new Set<string>();
  const breakdown: string[] = [];
  let awaiting = 0;
  let noLines = 0;
  let noVendor = 0;
  let noItem = 0;
  let wrongStatus = 0;

  for (const row of rows) {
    if (!canBulkApproveStatus(row.status)) {
      flaggedIds.add(row.id);
      wrongStatus += 1;
      continue;
    }
    const flags = poFlags(row);
    if (flags.length === 0) continue;
    flaggedIds.add(row.id);
    if (flags.includes('awaiting_info')) awaiting += 1;
    if (flags.includes('no_line_items')) noLines += 1;
    if (flags.includes('missing_zoho_vendor')) noVendor += 1;
    if (flags.includes('missing_zoho_item')) noItem += 1;
  }

  if (awaiting) breakdown.push(`${awaiting} have unresolved issues`);
  if (noLines) breakdown.push(`${noLines} have no line items`);
  if (noVendor) breakdown.push(`${noVendor} missing Zoho vendor`);
  if (noItem) breakdown.push(`${noItem} missing Zoho item IDs`);
  if (wrongStatus) breakdown.push(`${wrongStatus} not in submitted/in_review`);

  const flaggedRows = rows.filter((e) => flaggedIds.has(e.id));
  const readyRows = rows.filter((e) => !flaggedIds.has(e.id) && canBulkApproveStatus(e.status));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
      <div className="w-full max-w-md rounded-2xl border border-ink/10 bg-white p-6 shadow-panel">
        <h2 className="font-display text-xl font-semibold text-ink">
          Approve {rows.length} PO{rows.length !== 1 ? 's' : ''}?
        </h2>
        <p className="mt-1 text-sm text-charcoal/60">
          Total selected: <span className="font-semibold text-ink">{fmtMoney(total)}</span>
        </p>

        {breakdown.length > 0 && (
          <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3">
            <p className="text-xs font-semibold text-amber-900">Flagged in this selection:</p>
            <ul className="mt-1 space-y-0.5">
              {breakdown.map((line) => (
                <li key={line} className="text-xs text-amber-800">• {line}</li>
              ))}
            </ul>
          </div>
        )}

        {flaggedRows.length > 0 && (
          <div className="mt-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-charcoal/45">Will be skipped</p>
            <ul className="mt-1 max-h-28 overflow-y-auto text-xs text-charcoal/60">
              {flaggedRows.map((e) => (
                <li key={e.id}>{e.vendorName} · {fmtMoney(Number(e.total))}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-ink/15 px-4 py-2 text-sm font-medium text-ink hover:bg-ink/[0.03]"
          >
            Cancel
          </button>
          {readyRows.length > 0 ? (
            <button
              type="button"
              disabled={isPending}
              onClick={() => onConfirm(readyRows.map((e) => e.id), flaggedRows.length)}
              className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-cream hover:bg-brand-600 disabled:opacity-60"
            >
              {isPending ? 'Approving…' : `Approve ${readyRows.length} ready PO${readyRows.length !== 1 ? 's' : ''}`}
            </button>
          ) : (
            <p className="self-center text-xs text-charcoal/50">
              Every selected PO is flagged — nothing to approve.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
