import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import { reportApi, type ReportRow, type ReportSummary, type ReportType } from '../api/reports';
import { PRESETS, presetRange } from '../lib/reportRanges';
import { PageHeader } from '../components/PageHeader';
import { ShowTiles, EventBreakdownView } from './EventBreakdownView';

/** Dataviz-validated categorical palette — fixed slot order, never cycled. */
const SERIES = ['#1E3A55', '#D4AF37', '#2F7D5A', '#4E6E90', '#C94C4C', '#7A6414', '#16293C', '#94AAC4'];
const OTHER_COLOR = '#94AAC4';
const INK_MUTED = '#5C6773';
const GRID = '#E3E9F0';

const SCOPES: Array<{ id: ReportType; label: string; eyebrow: string }> = [
  { id: 'daily', label: 'Daily', eyebrow: 'Daily expenses' },
  { id: 'event', label: 'Trade Show', eyebrow: 'Trade show expenses' },
];

function usd(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function usdCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1000) return `$${(n / 1000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  return `$${n.toFixed(0)}`;
}

function csvCell(value: string | number): string {
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCsv(scope: ReportType, from: string, to: string, data: ReportSummary) {
  const rows: string[][] = [['section', 'name', 'spend', 'count']];
  const add = (section: string, list: ReportRow[]) => {
    for (const r of list) rows.push([section, r.name, r.spend.toFixed(2), String(r.count)]);
  };
  add('category', data.byCategory);
  add('company', data.byEntity);
  if (scope === 'event') add('show', data.byEvent ?? []);
  add('payment_method', data.byPaymentMethod);
  add('vendor', data.topVendors);
  add('spender', data.topUsers);
  for (const p of data.byPeriod) {
    rows.push(['period', p.label, p.spend.toFixed(2), String(p.count)]);
  }
  const body = rows.map((line) => line.map(csvCell).join(',')).join('\n');
  const blob = new Blob([body], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `midas-${scope === 'event' ? 'trade-show' : 'daily'}-${from}-${to}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function foldRows(rows: ReportRow[], max: number): Array<ReportRow & { color: string }> {
  const head = rows.slice(0, max).map((r, i) => ({ ...r, color: SERIES[i % SERIES.length] }));
  const tail = rows.slice(max);
  if (tail.length === 0) return head;
  return [...head, {
    name: 'Other',
    spend: tail.reduce((s, r) => s + r.spend, 0),
    count: tail.reduce((s, r) => s + r.count, 0),
    color: OTHER_COLOR,
  }];
}

function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ payload?: ReportRow; value?: number }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  const name = label ?? p.payload?.name;
  const spend = p.payload?.spend ?? p.value ?? 0;
  const count = p.payload?.count ?? 0;
  return (
    <div className="rounded-lg border border-ink/10 bg-white px-3 py-2 text-xs shadow-sm">
      <p className="font-medium text-ink">{name}</p>
      <p className="mt-0.5 text-charcoal/70">{usd(spend)} · {count} expense{count !== 1 ? 's' : ''}</p>
    </div>
  );
}

function Section({
  kicker,
  title,
  children,
}: {
  kicker: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-charcoal/40">{kicker}</p>
      <h2 className="mt-1 font-display text-xl font-semibold text-ink">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-ink/10 bg-white p-5 shadow-panel ${className}`}>
      {children}
    </div>
  );
}

function HorizontalBars({ rows }: { rows: Array<ReportRow & { color: string }> }) {
  const max = Math.max(...rows.map((r) => r.spend), 1);
  const total = rows.reduce((s, r) => s + r.spend, 0) || 1;
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <div key={r.name}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate font-medium text-ink" title={r.name}>{r.name}</span>
            <span className="shrink-0 tabular-nums text-charcoal/80">
              {usd(r.spend)}
              <span className="ml-2 text-xs text-charcoal/40">{Math.round((r.spend / total) * 100)}%</span>
            </span>
          </div>
          <div className="h-3.5 overflow-hidden rounded bg-brand-50">
            <div
              className="h-full rounded transition-[width] duration-200"
              style={{ width: `${(r.spend / max) * 100}%`, backgroundColor: r.color }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function RankedTable({ rows, nameHeader }: { rows: ReportRow[]; nameHeader: string }) {
  const max = Math.max(...rows.map((r) => r.spend), 1);
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-charcoal/40">No data in this range.</p>;
  }
  return (
    <>
      <div className="space-y-2.5 md:hidden">
        {rows.map((r, i) => (
          <div key={r.name}>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate font-medium text-ink" title={r.name}>
                <span className="mr-1.5 font-normal text-charcoal/40">{i + 1}</span>{r.name}
              </span>
              <span className="shrink-0 tabular-nums text-charcoal/80">{usd(r.spend)}</span>
            </div>
            <div className="mt-1 h-2.5 w-full overflow-hidden rounded bg-brand-50">
              <div className="h-full rounded bg-brand-400" style={{ width: `${(r.spend / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink/5 text-left field-caption">
              <th className="py-2 pr-2 w-8">#</th>
              <th className="py-2 pr-2">{nameHeader}</th>
              <th className="py-2 pr-2 text-right">Count</th>
              <th className="py-2 pr-2 text-right">Spend</th>
              <th className="py-2 pl-3 w-1/3">Share</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink/5">
            {rows.map((r, i) => (
              <tr key={r.name} className="hover:bg-ink/[0.03]">
                <td className="py-2.5 pr-2 tabular-nums text-charcoal/40">{i + 1}</td>
                <td className="max-w-0 truncate py-2.5 pr-2 font-medium text-ink" title={r.name}>{r.name}</td>
                <td className="py-2.5 pr-2 text-right tabular-nums text-muted">{r.count}</td>
                <td className="py-2.5 pr-2 text-right tabular-nums text-charcoal/80">{usd(r.spend)}</td>
                <td className="py-2.5 pl-3">
                  <div className="h-2.5 w-full overflow-hidden rounded bg-brand-50">
                    <div className="h-full rounded bg-brand-400" style={{ width: `${(r.spend / max) * 100}%` }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function parseScope(raw: string | null): ReportType {
  return raw === 'event' ? 'event' : 'daily';
}

export function Reports() {
  const [params, setParams] = useSearchParams();
  const scope = parseScope(params.get('scope'));
  const scopeMeta = SCOPES.find((s) => s.id === scope) ?? SCOPES[0];

  const [preset, setPreset] = useState('this_quarter');
  const [range, setRange] = useState(() => presetRange('this_quarter'));
  const [entity, setEntity] = useState('');
  // Drill-down is URL-backed so a show breakdown is linkable and the browser
  // back button returns to the grid.
  const selectedShow = params.get('show');
  const [showCompany, setShowCompany] = useState('');

  function selectShow(next: string | null) {
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      if (next) p.set('show', next);
      else p.delete('show');
      return p;
    }, { replace: false });
  }

  const { data, isLoading } = useQuery({
    queryKey: ['report-summary', range.from, range.to, entity, scope],
    queryFn: () => reportApi.summary({
      from: range.from,
      to: range.to,
      type: scope,
      ...(entity ? { entity } : {}),
    }),
  });

  const categories = useMemo(() => foldRows(data?.byCategory ?? [], 8), [data]);
  const entities = useMemo(() => foldRows(data?.byEntity ?? [], 8), [data]);
  const paymentMethods = useMemo(() => foldRows(data?.byPaymentMethod ?? [], 8), [data]);
  const shows = data?.byEvent ?? [];
  const entityOptions = useMemo(
    () => (data?.byEntity ?? []).map((e) => e.name).filter((n) => n !== 'Unassigned'),
    [data],
  );

  function setScope(next: ReportType) {
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      p.set('scope', next);
      p.delete('show');
      return p;
    }, { replace: true });
    setEntity('');
  }

  function applyPreset(id: string) {
    setPreset(id);
    setRange(presetRange(id));
  }

  function applyCustom(field: 'from' | 'to', value: string) {
    if (!value) return;
    setPreset('custom');
    setRange((r) => ({ ...r, [field]: value }));
  }

  const empty = !isLoading && (data?.totals.count ?? 0) === 0;
  const fieldClass = 'field lg:py-1.5';

  return (
    <div className="page">
      <PageHeader
        title="Reports"
        subtitle={`${scopeMeta.eyebrow} · ${range.from} to ${range.to}${entity ? ` · ${entity}` : ''}${data && !isLoading ? ` · ${data.totals.count.toLocaleString()} expenses · ${usd(data.totals.spend)}` : ''}`}
        actions={
          <button
            type="button"
            disabled={!data || empty}
            onClick={() => data && downloadCsv(scope, range.from, range.to, data)}
            className="btn-primary"
          >
            <Download className="h-4 w-4" />
            Export CSV
          </button>
        }
      />

      <div
        role="radiogroup"
        aria-label="Report type"
        className="mb-5 inline-flex rounded-full border border-ink/10 bg-brand-50 p-1"
      >
        {SCOPES.map((s) => {
          const active = scope === s.id;
          return (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setScope(s.id)}
              className={`min-h-11 cursor-pointer rounded-full px-5 py-2 text-sm font-semibold transition-colors duration-200 lg:min-h-0 ${
                active
                  ? 'bg-brand-500 text-cream shadow-sm'
                  : 'text-charcoal/70 hover:text-ink'
              }`}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      {selectedShow ? (
        <EventBreakdownView event={selectedShow} onBack={() => selectShow(null)} />
      ) : (
      <>
      <div className="mb-6 flex flex-col gap-3">
        <div className="flex flex-wrap gap-1 rounded-lg border border-ink/10 bg-brand-50 p-1 self-start">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => applyPreset(p.id)}
              className={`min-h-11 cursor-pointer rounded-md px-3 text-sm font-medium transition-colors lg:min-h-0 lg:py-1.5 ${
                preset === p.id ? 'bg-white text-ink shadow-sm' : 'text-charcoal/70 hover:text-ink'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs font-medium text-muted" htmlFor="report-from">From</label>
          <input
            id="report-from"
            type="date"
            value={range.from}
            onChange={(e) => applyCustom('from', e.target.value)}
            className={fieldClass}
          />
          <label className="text-xs font-medium text-muted" htmlFor="report-to">To</label>
          <input
            id="report-to"
            type="date"
            value={range.to}
            onChange={(e) => applyCustom('to', e.target.value)}
            className={fieldClass}
          />
          <label className="sr-only" htmlFor="report-company">Company</label>
          <select
            id="report-company"
            value={entity}
            onChange={(e) => setEntity(e.target.value)}
            className={fieldClass}
          >
            <option value="">All companies</option>
            {entityOptions.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-5" aria-busy="true" aria-label="Loading report">
          <div className="h-44 animate-pulse rounded-2xl bg-brand-800/80 motion-reduce:animate-none" />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-xl border border-ink/10 bg-white motion-reduce:animate-none" />
            ))}
          </div>
        </div>
      ) : data && (
        <div className="space-y-10">
          <div className="overflow-hidden rounded-2xl bg-brand-800 px-5 py-6 text-cream shadow-panel sm:px-7">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gold-400">
              {scopeMeta.eyebrow}
            </p>
            <p className="mt-2 font-display text-4xl font-semibold tabular-nums sm:text-5xl">
              {usd(data.totals.spend)}
            </p>
            <div className="mt-5 grid grid-cols-2 gap-4 border-t border-white/10 pt-4 sm:grid-cols-4">
              <HeroStat label="Expenses" value={data.totals.count.toLocaleString()} />
              <HeroStat label="Average" value={usd(data.totals.avg)} />
              <HeroStat label="Largest" value={usd(data.totals.largest)} />
              <HeroStat
                label="Outstanding"
                value={usd(data.reimbursement.outstanding)}
              />
            </div>
          </div>

          {empty ? (
            <Card>
              <p className="py-10 text-center text-sm text-muted">
                No {scope === 'event' ? 'trade show' : 'daily'} expenses in this range.
              </p>
            </Card>
          ) : (
            <>
              {scope === 'event' && (
                <Section kicker="Click a show for its full breakdown" title="Trade show investment">
                  <ShowTiles
                    shows={shows}
                    companyFilter={showCompany}
                    onCompanyFilter={setShowCompany}
                    onSelect={(name) => selectShow(name)}
                  />
                </Section>
              )}

              <Section kicker="Where the money went" title="Company totals">
                {entities.length === 0 ? (
                  <p className="text-sm text-charcoal/40">No company totals.</p>
                ) : (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {entities.map((e) => (
                      <div key={e.name} className="rounded-xl border border-ink/10 bg-white px-4 py-4">
                        <p className="truncate field-caption" title={e.name}>
                          {e.name}
                        </p>
                        <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-ink">
                          {usdCompact(e.spend)}
                        </p>
                        <p className="mt-0.5 text-xs text-charcoal/40">{e.count} expense{e.count !== 1 ? 's' : ''}</p>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section kicker="What you've spent most on" title="Spend by category">
                <Card>
                  {categories.length === 0
                    ? <p className="py-6 text-center text-sm text-charcoal/40">No categories in this range.</p>
                    : <HorizontalBars rows={categories} />}
                </Card>
              </Section>

              <Section
                kicker={`Spend over time`}
                title={`By ${data.granularity === 'week' ? 'week' : 'month'}`}
              >
                <Card>
                  <div aria-label={`Spend by ${data.granularity}`}>
                    <ResponsiveContainer width="100%" height={280}>
                      <BarChart data={data.byPeriod} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                        <CartesianGrid vertical={false} stroke={GRID} />
                        <XAxis dataKey="label" tick={{ fill: INK_MUTED, fontSize: 12 }} axisLine={{ stroke: '#e5e7eb' }} tickLine={false} interval="preserveStartEnd" />
                        <YAxis tickFormatter={usdCompact} tick={{ fill: INK_MUTED, fontSize: 12 }} axisLine={false} tickLine={false} width={56} />
                        <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
                        <Bar dataKey="spend" fill={SERIES[0]} radius={[4, 4, 0, 0]} maxBarSize={40} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </Card>
              </Section>

              <div className="grid gap-8 lg:grid-cols-2">
                <Section kicker="How it was paid" title="Payment methods">
                  <Card>
                    {paymentMethods.length === 0
                      ? <p className="py-6 text-center text-sm text-charcoal/40">No payment methods.</p>
                      : <HorizontalBars rows={paymentMethods} />}
                  </Card>
                </Section>
                <Section kicker="Who was paid" title="Top vendors">
                  <Card>
                    <RankedTable rows={data.topVendors} nameHeader="Vendor" />
                  </Card>
                </Section>
              </div>

              <Section kicker="Who spent it" title="Top spenders">
                <Card>
                  <RankedTable rows={data.topUsers} nameHeader="Name" />
                </Card>
              </Section>

              <Section kicker="Reimbursements" title="Outstanding vs paid">
                <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <MiniStat label="Reimbursable total" value={usd(data.reimbursement.reimbursableTotal)} />
                  <MiniStat label="Company card total" value={usd(data.reimbursement.companyCardTotal)} />
                  <MiniStat label="Outstanding" value={usd(data.reimbursement.outstanding)} warn={data.reimbursement.outstanding > 0} />
                  <MiniStat label="Paid" value={usd(data.reimbursement.paid)} />
                </div>
                {data.reimbursement.byEmployee.length > 0 && (
                  <Card>
                    <p className="mb-3 field-caption">By employee</p>
                    <div className="divide-y divide-ink/5 md:hidden">
                      {data.reimbursement.byEmployee.map((r) => (
                        <div key={r.name} className="flex items-center justify-between gap-3 py-2 text-sm">
                          <span className="min-w-0 truncate font-medium text-ink" title={r.name}>{r.name}</span>
                          <span className="shrink-0 tabular-nums text-charcoal/80">
                            {usd(r.outstanding)} <span className="text-charcoal/40">due</span>
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="hidden overflow-x-auto md:block">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-ink/5 text-left field-caption">
                            <th className="py-2 pr-2">Name</th>
                            <th className="py-2 pr-2 text-right">Outstanding</th>
                            <th className="py-2 pl-3 text-right">Paid</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-ink/5">
                          {data.reimbursement.byEmployee.map((r) => (
                            <tr key={r.name}>
                              <td className="max-w-0 truncate py-2 pr-2 font-medium text-ink" title={r.name}>{r.name}</td>
                              <td className="py-2 pr-2 text-right tabular-nums text-charcoal/80">{usd(r.outstanding)}</td>
                              <td className="py-2 pl-3 text-right tabular-nums text-charcoal/80">{usd(r.paid)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                )}
              </Section>

              {scope === 'daily' && (data.budgets?.length ?? 0) > 0 && (
                <Section kicker="Budgets" title="Budget vs spend">
                  <Card>
                    <div className="space-y-3 md:hidden">
                      {data.budgets!.map((b) => (
                        <div key={b.id} className="rounded-lg border border-ink/5 p-3 text-sm">
                          <div className="flex items-center justify-between gap-3">
                            <span className="min-w-0 truncate font-medium text-ink">{b.companyName}</span>
                            <span className={`shrink-0 font-medium ${b.remaining < 0 ? 'text-danger' : 'text-success'}`}>
                              {usd(b.remaining)}
                            </span>
                          </div>
                          <p className="mt-0.5 text-xs text-muted">{b.period} · {b.categoryName ?? 'All'}</p>
                        </div>
                      ))}
                    </div>
                    <div className="hidden overflow-x-auto md:block">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b text-left text-xs uppercase tracking-wider text-muted">
                            <th className="py-2 pr-3">Company</th>
                            <th className="py-2 pr-3">Period</th>
                            <th className="py-2 pr-3">Category</th>
                            <th className="py-2 pr-3 text-right">Budget</th>
                            <th className="py-2 pr-3 text-right">Spend</th>
                            <th className="py-2 text-right">Remaining</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {data.budgets!.map((b) => (
                            <tr key={b.id}>
                              <td className="py-2 pr-3">{b.companyName}</td>
                              <td className="py-2 pr-3 text-muted">{b.period}</td>
                              <td className="py-2 pr-3 text-muted">{b.categoryName ?? 'All'}</td>
                              <td className="py-2 pr-3 text-right tabular-nums">{usd(b.budget)}</td>
                              <td className="py-2 pr-3 text-right tabular-nums">{usd(b.spend)}</td>
                              <td className={`py-2 text-right font-medium tabular-nums ${b.remaining < 0 ? 'text-danger' : 'text-success'}`}>
                                {usd(b.remaining)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                </Section>
              )}

              {scope === 'daily' && data.ops && (
                <Section kicker="Queue health" title="Still open">
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                    <MiniStat label="Pending review" value={data.ops.pendingReview} />
                    <MiniStat label="Awaiting info" value={data.ops.awaitingInfo} />
                    <MiniStat label="Zoho failed" value={data.ops.zohoFailed} warn={data.ops.zohoFailed > 0} />
                    <MiniStat label="OCR needs review" value={data.ops.ocrNeedsReview} warn={data.ops.ocrNeedsReview > 0} />
                    <MiniStat label="Open POs" value={data.ops.purchaseOrdersOpen} />
                  </div>
                </Section>
              )}
            </>
          )}
        </div>
      )}
      </>
      )}
    </div>
  );
}

function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wider text-cream/75">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums sm:text-xl">{value}</p>
    </div>
  );
}

function MiniStat({ label, value, warn = false }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div className={`rounded-xl border px-4 py-3 ${warn ? 'border-amber-300 bg-amber-50' : 'border-ink/10 bg-white'}`}>
      <p className={`text-xs font-medium ${warn ? 'text-amber-800' : 'text-muted'}`}>{label}</p>
      <p className={`mt-0.5 font-display text-xl font-semibold tabular-nums ${warn ? 'text-amber-950' : 'text-ink'}`}>
        {value}
      </p>
    </div>
  );
}
