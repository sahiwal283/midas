import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import api from '../api/client';
import { SearchableSelect } from '../components/SearchableSelect';
import { ZohoSyncCard } from '../components/ZohoSyncCard';
import { useAuth } from '../contexts/AuthContext';
import type { Transaction } from '@midas/shared';
import { roleAllowed } from '../lib/roles';

type ZohoVendor = { vendorId: string; vendorName: string; companyName?: string | null };
type ZohoItem = { itemId: string; name: string; unit?: string | null };

export function PurchaseOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const isPrivileged = roleAllowed(user?.role, ['accountant', 'admin']);
  const [pushError, setPushError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['transaction', id],
    queryFn: async () => (await api.get<{ transaction: Transaction }>(`/transactions/${id}`)).data.transaction,
    enabled: !!id,
  });

  const vendorsQ = useQuery({
    queryKey: ['zoho-vendors'],
    queryFn: async () => (await api.get<{ vendors: ZohoVendor[] }>('/transactions/meta/vendors')).data.vendors,
    staleTime: 60_000,
    enabled: !!q.data && (
      q.data.status === 'draft'
      || q.data.status === 'awaiting_info'
      || (isPrivileged && q.data.status === 'approved' && !q.data.zohoRecordId)
    ),
  });

  const itemsQ = useQuery({
    queryKey: ['zoho-items'],
    queryFn: async () => (await api.get<{ items: ZohoItem[] }>('/transactions/meta/items')).data.items,
    staleTime: 60_000,
    enabled: !!q.data && (
      q.data.status === 'draft'
      || q.data.status === 'awaiting_info'
      || (isPrivileged && q.data.status === 'approved' && !q.data.zohoRecordId)
    ),
  });

  const submit = useMutation({
    mutationFn: async () => (await api.post<{ transaction: Transaction }>(`/transactions/${id}/submit`)).data.transaction,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transaction', id] }),
  });

  const cancel = useMutation({
    mutationFn: async () => (await api.post(`/transactions/${id}/cancel`)).data,
    onSuccess: () => navigate('/expenses/new'),
  });

  const patch = useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      (await api.patch<{ transaction: Transaction }>(`/transactions/${id}`, body)).data.transaction,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transaction', id] }),
  });

  const pushZoho = useMutation({
    mutationFn: async () =>
      (await api.post<{ transaction: Transaction }>(`/accountant/purchase-orders/${id}/zoho-push`)).data.transaction,
    onSuccess: () => {
      setPushError(null);
      void qc.invalidateQueries({ queryKey: ['transaction', id] });
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message;
      setPushError(msg || 'Zoho PO push failed');
    },
  });

  if (q.isLoading) return <p className="p-6 text-sm text-charcoal/60">Loading…</p>;
  if (q.isError || !q.data) return <p className="p-6 text-sm text-danger">Transaction not found</p>;

  const tx = q.data;
  const lines = [...(tx.lineItems ?? [])].sort((a, b) => a.lineNumber - b.lineNumber);
  const editable = tx.status === 'draft' || tx.status === 'awaiting_info'
    || (isPrivileged && tx.status === 'approved' && tx.integrationStatus !== 'synced' && !tx.zohoRecordId);
  const canPush = isPrivileged
    && (tx.status === 'approved' || tx.integrationStatus === 'failed')
    && !!tx.purchaseOrder?.zohoVendorId
    && lines.length > 0
    && lines.every((li) => !!li.zohoItemId)
    && !tx.zohoRecordId;

  async function setVendor(zohoVendorId: string) {
    const v = (vendorsQ.data ?? []).find((x) => x.vendorId === zohoVendorId);
    await patch.mutateAsync({
      zohoVendorId: zohoVendorId || null,
      vendorName: v ? (v.companyName || v.vendorName) : tx.vendorName,
    });
  }

  async function setLineItem(lineNumber: number, zohoItemId: string) {
    const item = (itemsQ.data ?? []).find((x) => x.itemId === zohoItemId);
    const nextLines = lines.map((li) => {
      if (li.lineNumber !== lineNumber) {
        return {
          lineNumber: li.lineNumber,
          description: li.description,
          quantity: Number(li.quantity),
          unit: li.unit,
          unitPrice: Number(li.unitPrice),
          tax: Number(li.tax),
          total: Number(li.total),
          zohoItemId: li.zohoItemId,
          ocrConfidence: li.ocrConfidence != null ? Number(li.ocrConfidence) : null,
          needsReview: li.needsReview,
        };
      }
      return {
        lineNumber: li.lineNumber,
        description: li.description || item?.name || '',
        quantity: Number(li.quantity),
        unit: li.unit || item?.unit || null,
        unitPrice: Number(li.unitPrice),
        tax: Number(li.tax),
        total: Number(li.total),
        zohoItemId: zohoItemId || null,
        ocrConfidence: li.ocrConfidence != null ? Number(li.ocrConfidence) : null,
        needsReview: li.needsReview,
      };
    });
    await patch.mutateAsync({ lineItems: nextLines });
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      {!isPrivileged ? (
        <Link to="/expenses/new" className="text-sm font-medium text-brand-700">
          ← New transaction
        </Link>
      ) : (
        <Link to="/dashboard" className="text-sm font-medium text-brand-700">
          ← Dashboard
        </Link>
      )}
      <h1 className="mt-2 mb-1 font-display text-3xl font-semibold text-ink">Purchase Order</h1>
      <p className="mb-6 break-words text-sm text-charcoal/55">
        {tx.vendorName} · {tx.transactionDate} · <span className="uppercase tracking-wide">{tx.status}</span>
      </p>

      {tx.purchaseOrder?.poNumber && (
        <p className="mb-4 text-sm text-ink">PO # {tx.purchaseOrder.poNumber}</p>
      )}

      {isPrivileged && (
        <div className="mb-6">
          <ZohoSyncCard
            recordKind="purchase_order"
            record={{
              status: tx.status,
              zohoRecordId: tx.zohoRecordId ?? null,
              zohoSyncedAt: tx.zohoSyncedAt ?? null,
              zohoSyncError: tx.zohoSyncError ?? null,
              integrationStatus: tx.integrationStatus,
            }}
            onRetry={canPush || tx.integrationStatus === 'failed' ? () => pushZoho.mutate() : undefined}
            retrying={pushZoho.isPending}
          />
        </div>
      )}

      {pushError && (
        <p className="mb-4 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">{pushError}</p>
      )}

      {editable && (
        <label className="mb-4 block text-sm">
          <span className="text-charcoal/70">Zoho vendor</span>
          <SearchableSelect
            className="mt-1"
            disabled={patch.isPending || vendorsQ.isLoading}
            placeholder="Search Zoho vendors…"
            value={tx.purchaseOrder?.zohoVendorId ?? ''}
            onChange={(vendorId) => void setVendor(vendorId)}
            options={(vendorsQ.data ?? []).map((v) => ({
              value: v.vendorId,
              label: v.companyName || v.vendorName,
              hint: v.vendorId,
            }))}
          />
        </label>
      )}

      {/* Mobile: stacked line-item cards */}
      <div className="mb-6 space-y-3 md:hidden">
        {lines.map((li) => {
          const conf = li.ocrConfidence != null ? Number(li.ocrConfidence) : null;
          const lowConf = conf != null && conf < 0.7;
          return (
            <div key={li.id} className="rounded-xl border border-ink/10 bg-white p-4 shadow-panel">
              <p className="break-words text-sm font-medium text-ink">
                {li.description}
                {(li.needsReview || lowConf) && (
                  <span className="ml-2 text-xs text-amber-700">
                    verify{lowConf && conf != null ? ` (${Math.round(conf * 100)}%)` : ''}
                  </span>
                )}
              </p>
              {editable && (
                <label className="mt-3 block text-sm">
                  <span className="text-xs font-semibold uppercase tracking-wider text-charcoal/45">Zoho item</span>
                  <SearchableSelect
                    className="mt-1"
                    disabled={patch.isPending || itemsQ.isLoading}
                    placeholder="Search item…"
                    value={li.zohoItemId ?? ''}
                    onChange={(itemId) => void setLineItem(li.lineNumber, itemId)}
                    options={(itemsQ.data ?? []).map((it) => ({
                      value: it.itemId,
                      label: it.name,
                      hint: it.itemId,
                    }))}
                  />
                </label>
              )}
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <dt className="text-xs font-semibold uppercase tracking-wider text-charcoal/45">Qty</dt>
                <dd className="text-right">{li.quantity}</dd>
                <dt className="text-xs font-semibold uppercase tracking-wider text-charcoal/45">Unit</dt>
                <dd className="text-right">{li.unit ?? '—'}</dd>
                <dt className="text-xs font-semibold uppercase tracking-wider text-charcoal/45">Price</dt>
                <dd className="text-right">${Number(li.unitPrice).toFixed(2)}</dd>
                <dt className="text-xs font-semibold uppercase tracking-wider text-charcoal/45">Total</dt>
                <dd className="text-right font-medium tabular-nums">${Number(li.total).toFixed(2)}</dd>
              </dl>
            </div>
          );
        })}
      </div>

      {/* Desktop: read-only table */}
      <div className="mb-6 hidden overflow-x-auto rounded-xl border border-ink/10 bg-white shadow-panel md:block">
        <table className="min-w-full text-sm">
          <thead className="bg-brand-50/80 text-left">
            <tr>
              {editable && <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Zoho item</th>}
              <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Item</th>
              <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Qty</th>
              <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Unit</th>
              <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Price</th>
              <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((li) => {
              const conf = li.ocrConfidence != null ? Number(li.ocrConfidence) : null;
              const lowConf = conf != null && conf < 0.7;
              return (
                <tr key={li.id} className="border-t border-ink/5">
                  {editable && (
                    <td className="min-w-[12rem] px-3 py-2">
                      <SearchableSelect
                        disabled={patch.isPending || itemsQ.isLoading}
                        placeholder="Search item…"
                        value={li.zohoItemId ?? ''}
                        onChange={(itemId) => void setLineItem(li.lineNumber, itemId)}
                        options={(itemsQ.data ?? []).map((it) => ({
                          value: it.itemId,
                          label: it.name,
                          hint: it.itemId,
                        }))}
                      />
                    </td>
                  )}
                  <td className="px-3 py-2 text-ink">
                    {li.description}
                    {(li.needsReview || lowConf) && (
                      <span className="ml-2 text-xs text-amber-700">
                        verify{lowConf && conf != null ? ` (${Math.round(conf * 100)}%)` : ''}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">{li.quantity}</td>
                  <td className="px-3 py-2">{li.unit ?? '—'}</td>
                  <td className="px-3 py-2">${Number(li.unitPrice).toFixed(2)}</td>
                  <td className="px-3 py-2">${Number(li.total).toFixed(2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mb-8 space-y-1 text-sm text-ink">
        <div>Tax: ${Number(tx.taxTotal).toFixed(2)}</div>
        <div className="font-semibold">Total: ${Number(tx.total).toFixed(2)}</div>
      </div>

      <div className="flex flex-wrap gap-3">
        {tx.status === 'draft' && (
          <button
            type="button"
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-cream hover:bg-brand-600"
            disabled={submit.isPending}
            onClick={() => submit.mutate()}
          >
            Submit for review
          </button>
        )}
        {(tx.status === 'draft' || tx.status === 'submitted') && (
          <button
            type="button"
            className="rounded-lg border border-ink/15 px-4 py-2 text-sm font-medium text-ink hover:bg-ink/[0.03]"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            Cancel
          </button>
        )}
        {canPush && (
          <button
            type="button"
            className="rounded-lg bg-success px-4 py-2 text-sm font-semibold text-cream hover:opacity-90 disabled:opacity-50"
            disabled={pushZoho.isPending}
            onClick={() => pushZoho.mutate()}
          >
            {pushZoho.isPending ? 'Pushing…' : tx.integrationStatus === 'failed' ? 'Retry Zoho push' : 'Push to Zoho'}
          </button>
        )}
        {isPrivileged && tx.status === 'approved' && !canPush && !tx.zohoRecordId && (
          <p className="self-center text-xs text-amber-700">Map Zoho vendor + item IDs before push.</p>
        )}
      </div>
    </div>
  );
}
