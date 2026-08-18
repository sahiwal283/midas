import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell,
} from 'recharts';
import { reportApi, type ReportRow, type ReportType } from '../api/reports';
import { PRESETS, presetRange } from '../lib/reportRanges';

/** Dataviz-validated categorical palette — fixed slot order, never cycled. */
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const OTHER_COLOR = '#9ca3af';
const INK = '#374151';
const INK_MUTED = '#6b7280';
const GRID = '#f3f4f6';

function usd(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function usdCompact(n: number): string {
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

/** Fold rows beyond the first `max` into a single "Other" row (fixed slot order). */
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

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  const name = label ?? p.payload?.name;
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs shadow-sm">
      <p className="font-medium text-gray-900">{name}</p>
      <p className="mt-0.5 text-gray-600">{usd(p.payload?.spend ?? p.value)} · {p.payload?.count ?? 0} expense{(p.payload?.count ?? 0) !== 1 ? 's' : ''}</p>
    </div>
  );
}

function Card({ title, children, className = '' }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-gray-200 bg-white p-5 ${className}`}>
      {title && (
        <h2 className="mb-4 border-b border-gold-400/60 pb-2.5 text-sm font-semibold text-gray-700">{title}</h2>
      )}
      {children}
    </div>
  );
}

function KpiTile({ label, value, accent = false }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className={`rounded-xl border px-4 py-3 shadow-panel ${accent ? 'border-brand-500/30 bg-brand-500/5' : 'border-ink/10 bg-white'}`}>
      <p className={`text-xs font-medium ${accent ? 'text-brand-800' : 'text-charcoal/50'}`}>{label}</p>
      <p className={`mt-0.5 font-display text-xl font-semibold ${accent ? 'text-ink' : 'text-ink'}`}>{value}</p>
    </div>
  );
}

/** Horizontal breakdown: colored mark + name + share bar + value, all text in ink. */
function BreakdownList({ rows }: { rows: Array<ReportRow & { color: string }> }) {
  const max = Math.max(...rows.map((r) => r.spend), 1);
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.name} className="flex items-center gap-3">
          <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: r.color }} />
          <span className="w-28 truncate text-sm text-gray-700 md:w-40" title={r.name}>{r.name}</span>
          <div className="h-3.5 flex-1 overflow-hidden rounded bg-gray-100">
            <div className="h-full rounded" style={{ width: `${(r.spend / max) * 100}%`, backgroundColor: r.color }} />
          </div>
          <span className="w-24 shrink-0 text-right text-sm font-medium text-gray-900">{usd(r.spend)}</span>
        </div>
      ))}
    </div>
  );
}

function RankedTable({ title, rows }: { title: string; rows: ReportRow[] }) {
  const max = Math.max(...rows.map((r) => r.spend), 1);
  return (
    <Card title={title}>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-gray-400">No data in this range.</p>
      ) : (
        <>
        {/* Mobile list */}
        <div className="space-y-2.5 md:hidden">
          {rows.map((r, i) => (
            <div key={r.name}>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate font-medium text-gray-900" title={r.name}>
                  <span className="mr-1.5 font-normal text-gray-400">{i + 1}</span>{r.name}
                </span>
                <span className="shrink-0 text-gray-700">{usd(r.spend)}</span>
              </div>
              <div className="mt-1 h-2.5 w-full overflow-hidden rounded bg-gray-100">
                <div className="h-full rounded bg-brand-300" style={{ width: `${(r.spend / max) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
        {/* Desktop table */}
        <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
              <th className="py-2 pr-2 w-8">#</th>
              <th className="py-2 pr-2">Name</th>
              <th className="py-2 pr-2 text-right">Spend</th>
              <th className="py-2 pl-3 w-1/3">Share</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {rows.map((r, i) => (
              <tr key={r.name}>
                <td className="py-2 pr-2 text-gray-400">{i + 1}</td>
                <td className="py-2 pr-2 font-medium text-gray-900 truncate max-w-0" title={r.name}>{r.name}</td>
                <td className="py-2 pr-2 text-right text-gray-700">{usd(r.spend)}</td>
                <td className="py-2 pl-3">
                  <div className="h-2.5 w-full overflow-hidden rounded bg-gray-100">
                    <div className="h-full rounded bg-brand-300" style={{ width: `${(r.spend / max) * 100}%` }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        </>
      )}
    </Card>
  );
}

export function Reports() {
  const [preset, setPreset] = useState('this_quarter');
  const [range, setRange] = useState(() => presetRange('this_quarter'));
  const [entity, setEntity] = useState('');
  const [type, setType] = useState<ReportType | ''>('');

  const { data, isLoading } = useQuery({
    queryKey: ['report-summary', range.from, range.to, entity, type],
    queryFn: () => reportApi.summary({
      from: range.from,
      to: range.to,
      ...(entity ? { entity } : {}),
      ...(type ? { type } : {}),
    }),
  });

  const categories = useMemo(() => foldRows(data?.byCategory ?? [], 7), [data]);
  const entities = useMemo(() => foldRows(data?.byEntity ?? [], 8), [data]);
  const sourceApps = useMemo(() => foldRows(data?.bySourceApp ?? [], 8), [data]);
  const paymentMethods = useMemo(() => foldRows(data?.byPaymentMethod ?? [], 8), [data]);
  const entityOptions = useMemo(
    () => (data?.byEntity ?? []).map((e) => e.name).filter((n) => n !== 'Unassigned'),
    [data],
  );

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

  return (
    <div className="p-4 lg:p-8">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold text-ink">Reports</h1>
        <p className="mt-1 text-sm text-gray-500">
          Company-wide spend, {range.from} to {range.to}{entity ? ` · ${entity}` : ''}{type ? ` · ${type === 'daily' ? 'Daily' : 'Event'} expenses` : ''}
        </p>
      </div>

      {/* Filter bar */}
      <div className="mb-5 flex flex-col gap-3">
        <div className="flex flex-wrap gap-1 rounded-lg border border-gray-200 bg-gray-100 p-1 self-start">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => applyPreset(p.id)}
              className={`rounded-md px-3 py-2.5 text-sm font-medium transition-colors lg:py-1.5 ${
                preset === p.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs font-medium text-gray-500">From</label>
          <input
            type="date"
            value={range.from}
            onChange={(e) => applyCustom('from', e.target.value)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-3 text-sm text-gray-700 focus:border-brand-500 focus:outline-none lg:py-1.5"
          />
          <label className="text-xs font-medium text-gray-500">To</label>
          <input
            type="date"
            value={range.to}
            onChange={(e) => applyCustom('to', e.target.value)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-3 text-sm text-gray-700 focus:border-brand-500 focus:outline-none lg:py-1.5"
          />
          <div className="flex rounded-lg border border-gray-200 bg-gray-100 p-1">
            {([['', 'All'], ['daily', 'Daily'], ['event', 'Event']] as const).map(([id, label]) => (
              <button
                key={label}
                type="button"
                onClick={() => setType(id as ReportType | '')}
                className={`rounded-md px-3 py-2 text-sm font-medium transition-colors lg:py-1 ${
                  type === id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <select
            value={entity}
            onChange={(e) => setEntity(e.target.value)}
            className="max-w-full rounded-lg border border-gray-200 bg-white px-3 py-3 text-sm text-gray-700 focus:border-brand-500 focus:outline-none lg:py-1.5"
          >
            <option value="">All companies</option>
            {entityOptions.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="rounded-xl border border-gray-200 bg-white px-6 py-16 text-center text-sm text-gray-400">
          Loading report…
        </div>
      ) : empty ? (
        <div className="rounded-xl border border-gray-200 bg-white px-6 py-16 text-center text-sm text-gray-500">
          No expenses in this range.
        </div>
      ) : data && (
        <div className="space-y-5">
          {/* KPI tiles */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiTile label="Total spend" value={usd(data.totals.spend)} />
            <KpiTile label="Expenses" value={data.totals.count.toLocaleString()} />
            <KpiTile label="Average expense" value={usd(data.totals.avg)} />
            <KpiTile label="Reimbursements pending" value={usd(data.totals.reimbursementPending)} accent={data.totals.reimbursementPending > 0} />
          </div>

          {(data.byTransactionType?.length ?? 0) > 0 && (
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {data.byTransactionType!.map((row) => (
                <KpiTile
                  key={row.type}
                  label={row.type === 'purchase_order' ? 'Purchase orders' : 'Employee expenses'}
                  value={`${usd(row.spend)} · ${row.count}`}
                />
              ))}
            </div>
          )}

          {data.ops && (
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <KpiTile label="Pending review" value={data.ops.pendingReview} />
              <KpiTile label="Awaiting info" value={data.ops.awaitingInfo} />
              <KpiTile label="Zoho failed" value={data.ops.zohoFailed} accent={data.ops.zohoFailed > 0} />
              <KpiTile label="OCR needs review" value={data.ops.ocrNeedsReview} accent={data.ops.ocrNeedsReview > 0} />
              <KpiTile label="Open POs" value={data.ops.purchaseOrdersOpen} />
            </div>
          )}

          {(data.budgets?.length ?? 0) > 0 && (
            <div className="mb-6">
            <Card title="Budget vs spend">
              {/* Mobile cards */}
              <div className="space-y-3 md:hidden">
                {data.budgets!.map((b) => (
                  <div key={b.id} className="rounded-lg border border-gray-100 p-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate font-medium text-gray-900">{b.companyName}</span>
                      <span className={`shrink-0 font-medium ${b.remaining < 0 ? 'text-red-700' : 'text-green-700'}`}>
                        {usd(b.remaining)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-gray-500">{b.period} · {b.categoryName ?? 'All'}</p>
                    <div className="mt-2 flex justify-between text-gray-700">
                      <span>Budget {usd(b.budget)}</span>
                      <span>Spend {usd(b.spend)}</span>
                    </div>
                  </div>
                ))}
              </div>
              {/* Desktop table */}
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-gray-500 border-b">
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
                        <td className="py-2 pr-3 text-gray-500">{b.period}</td>
                        <td className="py-2 pr-3 text-gray-500">{b.categoryName ?? 'All'}</td>
                        <td className="py-2 pr-3 text-right">{usd(b.budget)}</td>
                        <td className="py-2 pr-3 text-right">{usd(b.spend)}</td>
                        <td className={`py-2 text-right font-medium ${b.remaining < 0 ? 'text-red-700' : 'text-green-700'}`}>
                          {usd(b.remaining)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            </div>
          )}

          {/* Spend over time */}
          <Card title={`Spend by ${data.granularity === 'week' ? 'week' : 'month'}`}>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={data.byPeriod} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis dataKey="label" tick={{ fill: INK_MUTED, fontSize: 12 }} axisLine={{ stroke: '#e5e7eb' }} tickLine={false} interval="preserveStartEnd" />
                <YAxis tickFormatter={usdCompact} tick={{ fill: INK_MUTED, fontSize: 12 }} axisLine={false} tickLine={false} width={56} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
                <Bar dataKey="spend" fill={SERIES[0]} radius={[4, 4, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          </Card>

          {/* Category donut + entity bars */}
          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="Spend by category">
              {categories.length === 0 ? (
                <p className="py-6 text-center text-sm text-gray-400">No data.</p>
              ) : (
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
                  <div className="w-full shrink-0 lg:w-[55%]">
                  <ResponsiveContainer width="100%" height={240}>
                    <PieChart>
                      <Pie
                        data={categories}
                        dataKey="spend"
                        nameKey="name"
                        innerRadius={60}
                        outerRadius={95}
                        paddingAngle={2}
                        stroke="#ffffff"
                        strokeWidth={2}
                      >
                        {categories.map((c) => (
                          <Cell key={c.name} fill={c.color} />
                        ))}
                      </Pie>
                      <Tooltip content={<ChartTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                  </div>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    {categories.map((c) => (
                      <div key={c.name} className="flex items-center gap-2 text-sm">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: c.color }} />
                        <span className="min-w-0 flex-1 truncate text-gray-700" title={c.name}>{c.name}</span>
                        <span className="shrink-0 font-medium text-gray-900">{usd(c.spend)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>
            <Card title="Spend by company">
              {entities.length === 0
                ? <p className="py-6 text-center text-sm text-gray-400">No data.</p>
                : <BreakdownList rows={entities} />}
            </Card>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="Spend by source / event">
              {sourceApps.length === 0
                ? <p className="py-6 text-center text-sm text-gray-400">No data.</p>
                : <BreakdownList rows={sourceApps} />}
            </Card>
            <Card title="Spend by payment method">
              {paymentMethods.length === 0
                ? <p className="py-6 text-center text-sm text-gray-400">No data.</p>
                : <BreakdownList rows={paymentMethods} />}
            </Card>
          </div>

          {/* Reimbursements */}
          <Card title="Reimbursements">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <KpiTile label="Reimbursable total" value={usd(data.reimbursement.reimbursableTotal)} />
              <KpiTile label="Company card total" value={usd(data.reimbursement.companyCardTotal)} />
              <KpiTile label="Outstanding" value={usd(data.reimbursement.outstanding)} accent={data.reimbursement.outstanding > 0} />
              <KpiTile label="Paid" value={usd(data.reimbursement.paid)} />
            </div>
            {data.reimbursement.byEmployee.length > 0 && (
              <div className="mt-4">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">By employee</h3>
                {/* Mobile list */}
                <div className="divide-y divide-gray-50 md:hidden">
                  {data.reimbursement.byEmployee.map((r) => (
                    <div key={r.name} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <span className="min-w-0 truncate font-medium text-gray-900" title={r.name}>{r.name}</span>
                      <span className="shrink-0 text-gray-700">
                        {usd(r.outstanding)} <span className="text-gray-400">due</span> · {usd(r.paid)} <span className="text-gray-400">paid</span>
                      </span>
                    </div>
                  ))}
                </div>
                {/* Desktop table */}
                <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                      <th className="py-2 pr-2">Name</th>
                      <th className="py-2 pr-2 text-right">Outstanding</th>
                      <th className="py-2 pl-3 text-right">Paid</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {data.reimbursement.byEmployee.map((r) => (
                      <tr key={r.name}>
                        <td className="py-2 pr-2 font-medium text-gray-900 truncate max-w-0" title={r.name}>{r.name}</td>
                        <td className="py-2 pr-2 text-right text-gray-700">{usd(r.outstanding)}</td>
                        <td className="py-2 pl-3 text-right text-gray-700">{usd(r.paid)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            )}
          </Card>

          {/* Ranked tables */}
          <div className="grid gap-5 lg:grid-cols-2">
            <RankedTable title="Top vendors" rows={data.topVendors} />
            <RankedTable title="Top spenders" rows={data.topUsers} />
          </div>
        </div>
      )}
    </div>
  );
}
