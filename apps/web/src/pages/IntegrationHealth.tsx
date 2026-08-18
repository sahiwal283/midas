import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CheckCircle2, XCircle, AlertTriangle, RefreshCw } from 'lucide-react';
import { accountantApi } from '../api/expenses';
import api from '../api/client';

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
      ok ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'
    }`}>
      {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
      {label}
    </span>
  );
}

export function IntegrationHealth() {
  const qc = useQueryClient();
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const health = useQuery({
    queryKey: ['zoho-service-health'],
    queryFn: () => accountantApi.zohoServiceHealth(),
    refetchInterval: 60_000,
  });

  const vendors = useQuery({
    queryKey: ['zoho-vendors-probe'],
    queryFn: async () =>
      (await api.get<{ vendors: unknown[]; source?: string }>('/transactions/meta/vendors')).data,
    retry: false,
  });

  const items = useQuery({
    queryKey: ['zoho-items-probe'],
    queryFn: async () =>
      (await api.get<{ items: unknown[]; source?: string }>('/transactions/meta/items')).data,
    retry: false,
  });

  const syncCatalog = useMutation({
    mutationFn: async () =>
      (await api.post<{
        vendors: { count: number; source: string };
        items: { count: number; source: string };
      }>('/transactions/meta/sync-catalog')).data,
    onSuccess: (data) => {
      setSyncMsg(
        `Catalog refreshed — ${data.vendors.count} vendors (${data.vendors.source}), ${data.items.count} items (${data.items.source})`,
      );
      void qc.invalidateQueries({ queryKey: ['zoho-vendors-probe'] });
      void qc.invalidateQueries({ queryKey: ['zoho-items-probe'] });
      void qc.invalidateQueries({ queryKey: ['zoho-vendors'] });
      void qc.invalidateQueries({ queryKey: ['zoho-items'] });
    },
    onError: () => setSyncMsg('Catalog refresh failed'),
  });

  const h = health.data;
  const serviceOk = !!h?.service?.ok;
  const authOk = h?.zohoAuth?.ok !== false && h?.zohoAuth != null;
  const live = !!h?.readyForLivePush;

  return (
    <div className="mx-auto max-w-3xl p-4 lg:p-8">
      <Link to="/accountant/daily" className="text-sm font-medium text-brand-700 hover:text-brand-800">
        ← Accountant workspace
      </Link>
      <h1 className="mt-2 font-display text-3xl font-semibold text-ink">Integration Health</h1>
      <p className="mb-6 mt-1 text-sm text-charcoal/55">
        Soft probe of Zoho Integration Service — never creates Books records.
      </p>

      {syncMsg && (
        <div className="mb-4 rounded-lg border border-brand-500/25 bg-brand-500/10 px-4 py-2 text-sm text-ink">
          {syncMsg}
          <button type="button" className="ml-3 text-xs font-medium text-brand-700 underline" onClick={() => setSyncMsg(null)}>
            Dismiss
          </button>
        </div>
      )}

      {health.isLoading ? (
        <p className="text-sm text-charcoal/40">Checking…</p>
      ) : health.isError || !h ? (
        <p className="text-sm text-danger">Could not load Zoho service health.</p>
      ) : (
        <div className="space-y-4">
          <div className="space-y-3 rounded-xl border border-ink/10 bg-white p-5 shadow-panel">
            <div className="flex flex-wrap gap-2">
              <StatusPill ok={serviceOk} label={serviceOk ? 'Service reachable' : 'Service down'} />
              <StatusPill ok={!!authOk} label={authOk ? 'Zoho auth OK' : 'Zoho auth blocked'} />
              <StatusPill ok={live} label={live ? 'Live writes enabled' : 'Live writes off'} />
            </div>
            <dl className="grid grid-cols-1 gap-3 text-sm text-charcoal/70 sm:grid-cols-2">
              <div><dt className="text-xs text-charcoal/40">Mode</dt><dd className="font-medium text-ink">{h.zohoMode}</dd></div>
              <div><dt className="text-xs text-charcoal/40">Dry run</dt><dd className="font-medium text-ink">{h.dryRun ? 'yes' : 'no'}</dd></div>
              <div><dt className="text-xs text-charcoal/40">Brand</dt><dd className="font-medium text-ink">{h.brand}</dd></div>
              <div><dt className="text-xs text-charcoal/40">Service version</dt><dd className="font-medium text-ink">{h.service?.serviceVersion ?? '—'}</dd></div>
              <div className="sm:col-span-2"><dt className="text-xs text-charcoal/40">Base URL</dt><dd className="break-all font-mono text-xs text-ink">{h.service?.baseUrl ?? '—'}</dd></div>
            </dl>
            {h.zohoAuth?.ok === false && (
              <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                {h.zohoAuth.code ?? 'AUTH'}: {h.zohoAuth.message ?? 'Authorization required'}
              </p>
            )}
          </div>

          <div className="rounded-xl border border-ink/10 bg-white p-5 shadow-panel">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-sm font-semibold text-ink">PO catalog</h2>
              <button
                type="button"
                disabled={syncCatalog.isPending}
                onClick={() => syncCatalog.mutate()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-semibold text-cream hover:bg-brand-600 disabled:opacity-60"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${syncCatalog.isPending ? 'animate-spin' : ''}`} />
                {syncCatalog.isPending ? 'Refreshing…' : 'Refresh catalog'}
              </button>
            </div>
            <ul className="space-y-2 text-sm">
              <li className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-charcoal/70">Vendors list</span>
                {vendors.isLoading ? <span className="text-charcoal/40">…</span>
                  : vendors.isError ? <StatusPill ok={false} label="Failed" />
                  : (
                    <StatusPill
                      ok
                      label={`${vendors.data?.vendors?.length ?? 0} vendors${vendors.data?.source ? ` · ${vendors.data.source}` : ''}`}
                    />
                  )}
              </li>
              <li className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-charcoal/70">Items list</span>
                {items.isLoading ? <span className="text-charcoal/40">…</span>
                  : items.isError ? <StatusPill ok={false} label="Failed" />
                  : (
                    <StatusPill
                      ok
                      label={`${items.data?.items?.length ?? 0} items${items.data?.source ? ` · ${items.data.source}` : ''}`}
                    />
                  )}
              </li>
            </ul>
            <p className="mt-3 text-xs text-charcoal/40">
              See docs/ZOHO_PO_CONTRACT.md for create path, Books body shape, and capability grants.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
