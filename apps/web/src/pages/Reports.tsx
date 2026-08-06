import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell,
} from 'recharts';
import { reportApi, type ReportRow } from '../api/reports';
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
      {title && <h2 className="mb-4 text-sm font-semibold text-gray-700">{title}</h2>}
      {children}
    </div>
  );
}

function KpiTile({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-xl border px-4 py-3 ${accent ? 'border-amber-200 bg-amber-50' : 'border-gray-200 bg-white'}`}>
      <p className={`text-xs font-medium ${accent ? 'text-amber-800' : 'text-gray-500'}`}>{label}</p>
      <p className={`mt-0.5 text-xl font-bold ${accent ? 'text-amber-900' : 'text-gray-900'}`}>{value}</p>
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
          <span className="w-40 truncate text-sm text-gray-700" title={r.name}>{r.name}</span>
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
      )}
    </Card>
  );
}

export function Reports() {
  const [preset, setPreset] = useState('this_quarter');
  const [range, setRange] = useState(() => presetRange('this_quarter'));
  const [entity, setEntity] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['report-summary', range.from, range.to, entity],
    queryFn: () => reportApi.summary({ from: range.from, to: range.to, ...(entity ? { entity } : {}) }),
  });

  const categories = useMemo(() => foldRows(data?.byCategory ?? [], 7), [data]);
  const entities = useMemo(() => foldRows(data?.byEntity ?? [], 8), [data]);
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
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Reports</h1>
        <p className="mt-1 text-sm text-gray-500">
          Company-wide spend, {range.from} to {range.to}{entity ? ` · ${entity}` : ''}
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
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
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
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 focus:border-brand-500 focus:outline-none"
          />
          <label className="text-xs font-medium text-gray-500">To</label>
          <input
            type="date"
            value={range.to}
            onChange={(e) => applyCustom('to', e.target.value)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 focus:border-brand-500 focus:outline-none"
          />
          <select
            value={entity}
            onChange={(e) => setEntity(e.target.value)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 focus:border-brand-500 focus:outline-none"
          >
            <option value="">All entities</option>
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

          {/* Spend over time */}
          <Card title={`Spend by ${data.granularity === 'week' ? 'week' : 'month'}`}>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={data.byPeriod} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis dataKey="label" tick={{ fill: INK_MUTED, fontSize: 12 }} axisLine={{ stroke: '#e5e7eb' }} tickLine={false} />
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
                <div className="flex items-center gap-4">
                  <ResponsiveContainer width="55%" height={240}>
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
            <Card title="Spend by entity">
              {entities.length === 0
                ? <p className="py-6 text-center text-sm text-gray-400">No data.</p>
                : <BreakdownList rows={entities} />}
            </Card>
          </div>

          {/* Payment methods */}
          <Card title="Spend by payment method">
            {paymentMethods.length === 0
              ? <p className="py-6 text-center text-sm text-gray-400">No data.</p>
              : <BreakdownList rows={paymentMethods} />}
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
