import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Download, X } from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { reportApi, type EventReportRow } from '../api/reports';
import { StatusBadge, ReimbursementBadge } from '../components/StatusBadge';
import {
  deriveBreakdown,
  isFilterEmpty,
  parseBreakdownFilter,
  serializeBreakdownFilter,
  type BreakdownFilter,
  type DerivedBreakdown,
} from '../lib/eventBreakdownFilter';

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

const EYEBROW = 'text-[11px] font-semibold uppercase tracking-[0.14em]';

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

// ── Breakdown ─────────────────────────────────────────────────────────────────

/**
 * Full-history breakdown of one trade show — company totals, who paid for
 * what, category × company matrix, and the detailed expense report. Mirrors
 * the trade show app's per-event report, including its drill-down: click a
 * company box to scope every panel to that company, tick categories to keep
 * only those. Both filters live in the URL beside `?show=`.
 */
export function EventBreakdownView({ event, onBack }: { event: string; onBack: () => void }) {
  const [params, setParams] = useSearchParams();
  const filter = useMemo(() => parseBreakdownFilter(params), [params]);

  function setFilter(next: BreakdownFilter, { push = false }: { push?: boolean } = {}) {
    setParams((prev) => serializeBreakdownFilter(new URLSearchParams(prev), next), { replace: !push });
  }
  const selectCompany = (company: string | null) => setFilter({ ...filter, company }, { push: true });
  const toggleCategory = (category: string) => setFilter({
    ...filter,
    categories: filter.categories.includes(category)
      ? filter.categories.filter((c) => c !== category)
      : [...filter.categories, category],
  });
  const clearCategories = () => setFilter({ ...filter, categories: [] });

  const { data, isLoading } = useQuery({
    queryKey: ['event-breakdown', event],
    queryFn: () => reportApi.eventBreakdown(event),
  });

  const rows = data?.expenses ?? [];
  // `scoped` narrows by company only: it drives the category list, so every
  // category stays tickable while others are selected. `view` applies both
  // filters and feeds every figure on the page.
  const scoped = useMemo(() => deriveBreakdown(rows, { company: filter.company, categories: [] }), [rows, filter.company]);
  const view = useMemo(() => deriveBreakdown(rows, filter), [rows, filter]);

  if (isLoading) {
    return <div className="panel px-6 py-12 text-center text-sm text-charcoal/40">Loading {event}…</div>;
  }
  if (!data) {
    return <div className="panel px-6 py-12 text-center text-sm text-muted">Could not load this show.</div>;
  }

  return (
    <div className="space-y-5">
      <ShowBand event={data.event} total={view.totals.spend} onBack={onBack} />

      {filter.company && (
        <CompanyBand company={filter.company} total={view.totals.spend} onBack={() => selectCompany(null)} />
      )}

      {filter.categories.length > 0 && (
        <CategoryChips categories={filter.categories} onRemove={toggleCategory} onClear={clearCategories} />
      )}

      {data.expenses.length >= 1000 && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          This show has more than 1,000 expenses; the breakdown covers the first 1,000 by date.
        </p>
      )}

      {!filter.company && (
        <CompanyBoxes entities={view.byEntity} onSelect={selectCompany} />
      )}

      <WhoPaidCard
        view={view}
        categories={scoped.categories}
        selected={filter.categories}
        onToggle={toggleCategory}
        onClear={clearCategories}
      />

      <MatrixTable event={data.event} view={view} />

      <DetailTable event={data.event} view={view} filtered={!isFilterEmpty(filter)} />
    </div>
  );
}

function ShowBand({ event, total, onBack }: { event: string; total: number; onBack: () => void }) {
  return (
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
          <p className={`${EYEBROW} text-brand-200`}>Viewing trade show</p>
          <h2 className="truncate font-display text-xl font-semibold text-cream">{event}</h2>
        </div>
      </div>
      <div className="text-right">
        <p className={`${EYEBROW} text-brand-200`}>Total expenses</p>
        <p className="text-2xl font-semibold tabular-nums">{usd(total)}</p>
      </div>
    </div>
  );
}

/** Second band that appears once a company box is clicked; its arrow undoes only that. */
function CompanyBand({ company, total, onBack }: { company: string; total: number; onBack: () => void }) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-4 rounded-xl px-5 py-4 text-cream"
      style={{ background: companyColor(company) }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded-full bg-white/15 p-2 transition-colors hover:bg-white/25"
          aria-label="Back to all companies"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0">
          <p className={`${EYEBROW} text-white/70`}>Viewing company</p>
          <h3 className="truncate font-display text-xl font-semibold">{company}</h3>
        </div>
      </div>
      <div className="text-right">
        <p className={`${EYEBROW} text-white/70`}>Total expenses</p>
        <p className="text-2xl font-semibold tabular-nums">{usd(total)}</p>
      </div>
    </div>
  );
}

function CategoryChips({ categories, onRemove, onClear }: {
  categories: string[];
  onRemove: (category: string) => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="mr-1 font-semibold uppercase tracking-[0.08em] text-charcoal/40">Showing only</span>
      {categories.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onRemove(c)}
          className="inline-flex items-center gap-1 rounded-full bg-brand-500 px-2.5 py-1 font-semibold text-cream hover:bg-brand-700"
          aria-label={`Stop filtering by ${c}`}
        >
          {c}
          <X className="h-3 w-3" />
        </button>
      ))}
      <button type="button" onClick={onClear} className="ml-1 font-medium text-charcoal/60 underline-offset-2 hover:underline">
        Clear all
      </button>
    </div>
  );
}

/** Company running totals — each box scopes the whole page to that company. */
function CompanyBoxes({ entities, onSelect }: {
  entities: DerivedBreakdown['byEntity'];
  onSelect: (company: string) => void;
}) {
  if (entities.length === 0) return null;
  return (
    <div>
      <p className={`${EYEBROW} mb-2 text-charcoal/40`}>Company totals <span className="normal-case tracking-normal text-charcoal/30">· click to view one company</span></p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {entities.map((e) => (
          <button
            key={e.name}
            type="button"
            onClick={() => onSelect(e.name)}
            className="rounded-xl border border-ink/10 bg-white px-4 py-3 text-left shadow-panel transition-colors hover:border-brand-500/40 hover:bg-ink/[0.02]"
          >
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: companyColor(e.name) }} />
              {e.name}
            </p>
            <p className="mt-0.5 text-xl font-semibold tabular-nums text-ink">{usd0(e.spend)}</p>
            <p className="text-[11px] text-charcoal/40">{e.count} expense{e.count !== 1 ? 's' : ''}</p>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Donut of company share plus one bar per category, split by company. Each
 * category row is a checkbox: ticking keeps only those categories everywhere
 * else on the page. Unticked rows stay listed (muted) so more can be added.
 */
function WhoPaidCard({ view, categories, selected, onToggle, onClear }: {
  view: DerivedBreakdown;
  categories: DerivedBreakdown['categories'];
  selected: string[];
  onToggle: (category: string) => void;
  onClear: () => void;
}) {
  const filtering = selected.length > 0;
  const scale = Math.max(...categories.map((c) => c.total), 1);
  const companies = view.byEntity;

  return (
    <div className="rounded-xl border border-ink/10 bg-white p-5 shadow-panel">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className={`${EYEBROW} text-charcoal/40`}>Who paid for what</p>
          <p className="text-xs text-muted">Each bar is split by paying company · tick categories to filter the page.</p>
        </div>
        {filtering && (
          <button type="button" onClick={onClear} className="btn-secondary !py-1 text-xs">
            <X className="h-3.5 w-3.5" />
            Clear {selected.length} {selected.length === 1 ? 'category' : 'categories'}
          </button>
        )}
      </div>
      <div className="mt-4 flex flex-col gap-6 lg:flex-row lg:items-start">
        <div className="mx-auto shrink-0 lg:mx-0">
          <div className="h-44 w-44">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={companies.map((e) => ({ name: e.name, value: e.spend }))}
                  dataKey="value"
                  innerRadius={52}
                  outerRadius={80}
                  strokeWidth={2}
                >
                  {companies.map((e) => (
                    <Cell key={e.name} fill={companyColor(e.name)} />
                  ))}
                </Pie>
                <Tooltip formatter={(v: number) => usd(v)} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 space-y-1">
            {companies.map((e) => (
              <p key={e.name} className="flex items-center gap-1.5 text-xs text-charcoal/70">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: companyColor(e.name) }} />
                <span className="min-w-0 flex-1 truncate">{e.name}</span>
                <span className="tabular-nums text-muted">
                  {usd0(e.spend)} · {view.totals.spend > 0 ? Math.round((e.spend / view.totals.spend) * 100) : 0}%
                </span>
              </p>
            ))}
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          {categories.length === 0 && (
            <p className="py-6 text-center text-sm text-muted">No expenses for this selection.</p>
          )}
          {categories.map((c) => {
            const on = selected.includes(c.category);
            const muted = filtering && !on;
            const split = Object.entries(c.byEntity).sort((a, b) => b[1] - a[1]);
            return (
              <label
                key={c.category}
                className={`block cursor-pointer rounded-lg border px-3 py-2 transition-colors ${
                  on ? 'border-brand-500/50 bg-brand-50/60' : 'border-transparent hover:bg-ink/[0.02]'
                } ${muted ? 'opacity-50' : ''}`}
              >
                <div className="flex items-baseline gap-2">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => onToggle(c.category)}
                    className="relative top-0.5 h-3.5 w-3.5 shrink-0 accent-brand-500"
                    aria-label={`Filter by ${c.category}`}
                  />
                  <p className="min-w-0 flex-1 truncate text-sm font-medium text-charcoal/80">{c.category}</p>
                  <p className="shrink-0 text-sm font-semibold tabular-nums text-ink">{usd0(c.total)}</p>
                </div>
                <div className="ml-5 mt-1 flex h-2.5 overflow-hidden rounded-full bg-ink/5" style={{ width: `calc(100% - 1.25rem)` }}>
                  <div className="flex h-full" style={{ width: `${(c.total / scale) * 100}%` }}>
                    {split.map(([name, v]) => (
                      <div
                        key={name}
                        title={`${name}: ${usd(v)}`}
                        style={{ width: `${(v / c.total) * 100}%`, background: companyColor(name) }}
                      />
                    ))}
                  </div>
                </div>
                {on && split.length > 0 && (
                  <p className="ml-5 mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-charcoal/60">
                    {split.map(([name, v]) => (
                      <span key={name} className="inline-flex items-center gap-1">
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: companyColor(name) }} />
                        {name}: <span className="tabular-nums">{usd0(v)}</span>
                      </span>
                    ))}
                  </p>
                )}
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MatrixTable({ event, view }: { event: string; view: DerivedBreakdown }) {
  return (
    <div className="panel">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink/5 px-4 py-3">
        <div>
          <p className={`${EYEBROW} text-charcoal/40`}>Category × company summary</p>
          <p className="text-xs text-muted">Exact amounts per paying company · for the selected filters.</p>
        </div>
        <button
          type="button"
          onClick={() => downloadCsv(`midas-${slug(event)}-summary.csv`, [
            ['category', ...view.byEntity.map((e) => e.name), 'total'],
            ...view.categories.map((c) => [
              c.category,
              ...view.byEntity.map((e) => (c.byEntity[e.name] ?? 0).toFixed(2)),
              c.total.toFixed(2),
            ]),
            ['Total', ...view.byEntity.map((e) => e.spend.toFixed(2)), view.totals.spend.toFixed(2)],
          ])}
          className="btn-secondary"
          disabled={view.categories.length === 0}
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
              {view.byEntity.map((e) => (
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
            {view.categories.length === 0 && (
              <tr>
                <td colSpan={view.byEntity.length + 2} className="px-4 py-6 text-center text-sm text-muted">
                  No expenses for this selection.
                </td>
              </tr>
            )}
            {view.categories.map((c) => (
              <tr key={c.category}>
                <td className="px-4 py-2.5 text-charcoal/80">{c.category}</td>
                {view.byEntity.map((e) => (
                  <td key={e.name} className="px-4 py-2.5 text-right tabular-nums text-charcoal/70">
                    {c.byEntity[e.name] ? usd(c.byEntity[e.name]) : '—'}
                  </td>
                ))}
                <td className="px-4 py-2.5 text-right font-medium tabular-nums text-ink">{usd(c.total)}</td>
              </tr>
            ))}
            <tr className="border-t border-ink/10 bg-brand-50/40 font-semibold">
              <td className="px-4 py-2.5 text-ink">Total</td>
              {view.byEntity.map((e) => (
                <td key={e.name} className="px-4 py-2.5 text-right tabular-nums text-ink">{usd(e.spend)}</td>
              ))}
              <td className="px-4 py-2.5 text-right tabular-nums text-ink">{usd(view.totals.spend)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DetailTable({ event, view, filtered }: { event: string; view: DerivedBreakdown; filtered: boolean }) {
  return (
    <div className="panel">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink/5 px-4 py-3">
        <div>
          <p className={`${EYEBROW} text-charcoal/40`}>Detailed expense report</p>
          <p className="text-xs text-muted">
            {view.totals.count} entr{view.totals.count === 1 ? 'y' : 'ies'} · {usd(view.totals.spend)} total{filtered ? ' · filtered' : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => downloadCsv(`midas-${slug(event)}-expenses.csv`, [
            ['date', 'merchant', 'category', 'card', 'amount', 'status', 'reimbursement', 'company', 'submitter', 'description'],
            ...view.expenses.map((e) => [
              e.date, e.merchant, e.categoryName ?? '', e.paymentMethod ?? '', e.amount.toFixed(2),
              e.status, e.reimbursementStatus, e.zohoEntity ?? '', e.userName ?? '', e.description ?? '',
            ]),
          ])}
          className="btn-secondary"
          disabled={view.expenses.length === 0}
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
            {view.expenses.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-sm text-muted">No expenses for this selection.</td>
              </tr>
            )}
            {view.expenses.map((e) => (
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
          Total expenses: {view.totals.count} · Approved: {view.totals.approved} · In progress: {view.totals.pending}
        </p>
        <p className="font-semibold text-ink">Total: {usd(view.totals.spend)}</p>
      </div>
    </div>
  );
}
