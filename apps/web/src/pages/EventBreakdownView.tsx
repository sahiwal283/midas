import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowLeft, Download } from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { reportApi, type EventReportRow } from '../api/reports';
import { StatusBadge, ReimbursementBadge } from '../components/StatusBadge';

/** Stable company colors across tiles, bars, donut, and table dots. */
export const COMPANY_COLORS: Record<string, string> = {
  'Haute Brands': '#2563EB',
  'Nirvana Kulture': '#EA580C',
  'Boomin Brands': '#16A34A',
  'Summitt Labs': '#CA8A04',
  Unassigned: '#94A3B8',
};

export function companyColor(name: string): string {
  return COMPANY_COLORS[name] ?? '#94A3B8';
}

function usd(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function usd0(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

function toCsvField(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function downloadCsv(filename: string, rows: string[][]): void {
  const csv = rows.map((r) => r.map(toCsvField).join(',')).join('\n') + '\n';
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function slug(name: string): string {
  return name.replace(/[^\w-]+/g, '_');
}

/**
 * Grid of show tiles — name, total, and a company-segmented bar. Clicking a
 * tile opens its full breakdown. Mirrors the trade show app's investment grid.
 */
export function ShowTiles({
  shows,
  companyFilter,
  onCompanyFilter,
  onSelect,
}: {
  shows: EventReportRow[];
  companyFilter: string;
  onCompanyFilter: (name: string) => void;
  onSelect: (event: string) => void;
}) {
  const companies = [...new Set(shows.flatMap((s) => s.entities.map((e) => e.name)))].sort();
  const visible = companyFilter
    ? shows
        .map((s) => {
          const seg = s.entities.find((e) => e.name === companyFilter);
          // Filtering by company re-scopes each tile to that company's spend,
          // so the bars stay comparable instead of showing untouched totals.
          return seg ? { ...s, spend: seg.spend, entities: [seg] } : null;
        })
        .filter((s): s is EventReportRow => s !== null)
        .sort((a, b) => b.spend - a.spend)
    : shows;
  const max = Math.max(...visible.map((s) => s.spend), 1);

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => onCompanyFilter('')}
          className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
            companyFilter === '' ? 'bg-brand-500 text-cream' : 'border border-ink/10 bg-white text-charcoal/70 hover:bg-ink/[0.03]'
          }`}
        >
          All companies
        </button>
        {companies.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onCompanyFilter(companyFilter === c ? '' : c)}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
              companyFilter === c ? 'bg-brand-500 text-cream' : 'border border-ink/10 bg-white text-charcoal/70 hover:bg-ink/[0.03]'
            }`}
          >
            <span className="h-2 w-2 rounded-full" style={{ background: companyColor(c) }} />
            {c}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">No shows match this filter.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((s) => (
            <button
              key={s.name}
              type="button"
              onClick={() => onSelect(s.name)}
              className="cursor-pointer rounded-xl border border-ink/10 bg-white p-4 text-left shadow-panel transition-colors hover:border-brand-500/40 hover:bg-ink/[0.02]"
            >
              <div className="flex items-baseline justify-between gap-3">
                <p className="min-w-0 truncate font-medium text-ink" title={s.name}>{s.name}</p>
                <p className="shrink-0 font-semibold tabular-nums text-ink">{usd0(s.spend)}</p>
              </div>
              {/* Bar length is the show's share of the largest show, so tiles
                  read as a league table at a glance; segments are companies. */}
              <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-ink/5">
                <div className="flex h-full" style={{ width: `${(s.spend / max) * 100}%` }}>
                  {s.entities.map((e) => (
                    <div
                      key={e.name}
                      title={`${e.name}: ${usd(e.spend)}`}
                      style={{ width: `${(e.spend / s.spend) * 100}%`, background: companyColor(e.name) }}
                    />
                  ))}
                </div>
              </div>
              <p className="mt-1.5 text-[11px] text-charcoal/40">
                {s.count} expense{s.count !== 1 ? 's' : ''} · {s.entities.map((e) => e.name).join(', ')}
              </p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Full-history breakdown of one trade show — company totals, who paid for
 * what, category × company matrix, and the detailed expense report. Mirrors
 * the trade show app's per-event report in Midas's design system.
 */
export function EventBreakdownView({ event, onBack }: { event: string; onBack: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['event-breakdown', event],
    queryFn: () => reportApi.eventBreakdown(event),
  });

  if (isLoading) {
    return <div className="panel px-6 py-12 text-center text-sm text-charcoal/40">Loading {event}…</div>;
  }
  if (!data) {
    return <div className="panel px-6 py-12 text-center text-sm text-muted">Could not load this show.</div>;
  }

  return (
    <div className="space-y-5">
      {/* Header band */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-brand-800 px-5 py-4 text-cream">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="rounded-full bg-white/10 p-2 transition-colors hover:bg-white/20"
            aria-label="Back to all shows"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-200">Viewing trade show</p>
            <h2 className="truncate font-display text-xl font-semibold text-cream">{data.event}</h2>
          </div>
        </div>
        <div className="text-right">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-200">Total expenses</p>
          <p className="text-2xl font-semibold tabular-nums">{usd(data.totals.spend)}</p>
        </div>
      </div>

      {/* Company running totals */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {data.byEntity.map((e) => (
          <div key={e.name} className="rounded-xl border border-ink/10 bg-white px-4 py-3 shadow-panel">
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: companyColor(e.name) }} />
              {e.name}
            </p>
            <p className="mt-0.5 text-xl font-semibold tabular-nums text-ink">{usd0(e.spend)}</p>
            <p className="text-[11px] text-charcoal/40">{e.count} expense{e.count !== 1 ? 's' : ''}</p>
          </div>
        ))}
      </div>

      {/* Who paid for what */}
      <div className="rounded-xl border border-ink/10 bg-white p-5 shadow-panel">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-charcoal/40">Who paid for what</p>
        <p className="text-xs text-muted">Each bar is split by paying company.</p>
        <div className="mt-4 flex flex-col gap-6 lg:flex-row lg:items-center">
          <div className="mx-auto h-44 w-44 shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data.byEntity.map((e) => ({ name: e.name, value: e.spend }))}
                  dataKey="value"
                  innerRadius={52}
                  outerRadius={80}
                  strokeWidth={2}
                >
                  {data.byEntity.map((e) => (
                    <Cell key={e.name} fill={companyColor(e.name)} />
                  ))}
                </Pie>
                <Tooltip formatter={(v: number) => usd(v)} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="min-w-0 flex-1 space-y-3">
            {data.categories.map((c) => (
              <div key={c.category}>
                <div className="flex items-baseline justify-between gap-3">
                  <p className="min-w-0 truncate text-sm font-medium text-charcoal/80">{c.category}</p>
                  <p className="shrink-0 text-sm font-semibold tabular-nums text-ink">{usd0(c.total)}</p>
                </div>
                <div className="mt-1 flex h-2.5 w-full overflow-hidden rounded-full bg-ink/5">
                  {data.byEntity.map((e) => {
                    const v = c.byEntity[e.name] ?? 0;
                    if (v <= 0) return null;
                    return (
                      <div
                        key={e.name}
                        title={`${e.name}: ${usd(v)}`}
                        style={{ width: `${(v / data.totals.spend) * 100}%`, background: companyColor(e.name) }}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-ink/5 pt-3">
          {data.byEntity.map((e) => (
            <span key={e.name} className="flex items-center gap-1.5 text-xs text-charcoal/70">
              <span className="h-2 w-2 rounded-full" style={{ background: companyColor(e.name) }} />
              {e.name}
              <span className="tabular-nums text-muted">
                {usd0(e.spend)} · {data.totals.spend > 0 ? Math.round((e.spend / data.totals.spend) * 100) : 0}%
              </span>
            </span>
          ))}
        </div>
      </div>

      {/* Category × company summary */}
      <div className="panel">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink/5 px-4 py-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-charcoal/40">Category × company summary</p>
            <p className="text-xs text-muted">Exact amounts per paying company.</p>
          </div>
          <button
            type="button"
            onClick={() => downloadCsv(`midas-${slug(data.event)}-summary.csv`, [
              ['category', ...data.byEntity.map((e) => e.name), 'total'],
              ...data.categories.map((c) => [
                c.category,
                ...data.byEntity.map((e) => (c.byEntity[e.name] ?? 0).toFixed(2)),
                c.total.toFixed(2),
              ]),
              ['Total', ...data.byEntity.map((e) => e.spend.toFixed(2)), data.totals.spend.toFixed(2)],
            ])}
            className="btn-secondary"
          >
            <Download className="h-4 w-4" />
            Summary CSV
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink/10 bg-brand-50/80 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                <th className="px-4 py-2.5">Category</th>
                {data.byEntity.map((e) => (
                  <th key={e.name} className="px-4 py-2.5 text-right">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full" style={{ background: companyColor(e.name) }} />
                      {e.name}
                    </span>
                  </th>
                ))}
                <th className="px-4 py-2.5 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {data.categories.map((c) => (
                <tr key={c.category}>
                  <td className="px-4 py-2.5 text-charcoal/80">{c.category}</td>
                  {data.byEntity.map((e) => (
                    <td key={e.name} className="px-4 py-2.5 text-right tabular-nums text-charcoal/70">
                      {c.byEntity[e.name] ? usd(c.byEntity[e.name]) : '—'}
                    </td>
                  ))}
                  <td className="px-4 py-2.5 text-right font-medium tabular-nums text-ink">{usd(c.total)}</td>
                </tr>
              ))}
              <tr className="border-t border-ink/10 bg-brand-50/40 font-semibold">
                <td className="px-4 py-2.5 text-ink">Total</td>
                {data.byEntity.map((e) => (
                  <td key={e.name} className="px-4 py-2.5 text-right tabular-nums text-ink">{usd(e.spend)}</td>
                ))}
                <td className="px-4 py-2.5 text-right tabular-nums text-ink">{usd(data.totals.spend)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Detailed expense report */}
      <div className="panel">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink/5 px-4 py-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-charcoal/40">Detailed expense report</p>
            <p className="text-xs text-muted">{data.totals.count} entries · {usd(data.totals.spend)} total</p>
          </div>
          <button
            type="button"
            onClick={() => downloadCsv(`midas-${slug(data.event)}-expenses.csv`, [
              ['date', 'merchant', 'category', 'card', 'amount', 'status', 'reimbursement', 'company', 'submitter', 'description'],
              ...data.expenses.map((e) => [
                e.date, e.merchant, e.categoryName ?? '', e.paymentMethod ?? '', e.amount.toFixed(2),
                e.status, e.reimbursementStatus, e.zohoEntity ?? '', e.userName ?? '', e.description ?? '',
              ]),
            ])}
            className="btn-secondary"
          >
            <Download className="h-4 w-4" />
            Export CSV
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink/10 bg-brand-50/80 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                <th className="px-4 py-2.5">Date</th>
                <th className="px-4 py-2.5">Merchant</th>
                <th className="px-4 py-2.5">Category</th>
                <th className="px-4 py-2.5">Card used</th>
                <th className="px-4 py-2.5 text-right">Amount</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Company</th>
                <th className="px-4 py-2.5">Description</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {data.expenses.map((e) => (
                <tr key={e.id} className="hover:bg-ink/[0.03]">
                  <td className="whitespace-nowrap px-4 py-2.5 text-charcoal/70">{e.date}</td>
                  <td className="px-4 py-2.5">
                    <Link to={`/accountant/${e.id}`} className="font-medium text-ink hover:text-brand-700">
                      {e.merchant}
                    </Link>
                    {e.userName && <p className="text-[11px] text-charcoal/40">{e.userName}</p>}
                  </td>
                  <td className="px-4 py-2.5 text-charcoal/70">{e.categoryName ?? '—'}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-charcoal/70">{e.paymentMethod ?? '—'}</td>
                  <td className="px-4 py-2.5 text-right font-medium tabular-nums text-ink">{usd(e.amount)}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-col items-start gap-1">
                      <StatusBadge status={e.status as never} variant="accountant" />
                      {e.reimbursementStatus !== 'not_requested' && (
                        <ReimbursementBadge status={e.reimbursementStatus as never} />
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    {e.zohoEntity ? (
                      <span className="flex items-center gap-1.5 whitespace-nowrap text-charcoal/70">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: companyColor(e.zohoEntity) }} />
                        {e.zohoEntity}
                      </span>
                    ) : '—'}
                  </td>
                  <td className="max-w-xs px-4 py-2.5">
                    <p className="line-clamp-2 text-xs text-charcoal/60">{e.description ?? '—'}</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink/5 px-4 py-2.5 text-xs text-charcoal/70">
          <p>
            Total expenses: {data.totals.count} · Approved: {data.totals.approved} · In progress: {data.totals.pending}
          </p>
          <p className="font-semibold text-ink">Total: {usd(data.totals.spend)}</p>
        </div>
      </div>
    </div>
  );
}
