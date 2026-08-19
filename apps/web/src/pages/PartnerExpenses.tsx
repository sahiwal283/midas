import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell,
} from 'recharts';
import client from '../api/client';
import { PageHeader } from '../components/PageHeader';

/** Same fixed-slot palette as the Reports page so both read as one system. */
const SERIES = ['#1E3A55', '#D4AF37', '#2F7D5A', '#4E6E90', '#C94C4C', '#7A6414', '#16293C', '#94AAC4'];
const GRID = '#E3E9F0';
const INK_MUTED = '#5C6773';

interface PartnerRow {
  id: string;
  date: string;
  merchant: string;
  amount: string;
  user?: { name: string } | null;
  category?: { name: string } | null;
  paymentMethod?: { label: string; lastFour: string | null } | null;
}

interface Summary {
  totals: { spend: number; count: number };
  granularity: string;
  byCategory: Array<{ name: string; spend: number; count: number }>;
  byPeriod: Array<{ period: string; label: string; spend: number; count: number }>;
  byPerson: Array<{ name: string; spend: number; count: number }>;
}

const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-ink/10 bg-white p-5 shadow-panel">
      <h2 className="mb-4 border-b border-gold-400/60 pb-2.5 text-sm font-semibold text-charcoal/80">{title}</h2>
      {children}
    </div>
  );
}

export function PartnerExpenses() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const params = useMemo(() => {
    const p: Record<string, string> = {};
    if (from) p.from = from;
    if (to) p.to = to;
    return p;
  }, [from, to]);

  const { data: rows = [], isLoading } = useQuery<PartnerRow[]>({
    queryKey: ['partner-expenses', params],
    queryFn: () => client.get('/partner-expenses', { params }).then((r) => r.data.expenses),
  });
  const { data: summary } = useQuery<Summary>({
    queryKey: ['partner-expenses-summary', params],
    queryFn: () => client.get('/partner-expenses/summary', { params }).then((r) => r.data),
  });

  return (
    <div className="page">
      <PageHeader
        title="Partner Expenses"
        subtitle="Spend marked as partner expenses. Not sent to accounting or Zoho."
      />

      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-charcoal/60" htmlFor="pe-from">From</label>
          <input id="pe-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="rounded-lg border border-ink/15 px-3 py-3 text-sm lg:py-2" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-charcoal/60" htmlFor="pe-to">To</label>
          <input id="pe-to" type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="rounded-lg border border-ink/15 px-3 py-3 text-sm lg:py-2" />
        </div>
        {summary && (
          <p className="ml-auto text-sm text-charcoal/60">
            <span className="font-display text-2xl font-semibold text-ink">{money(summary.totals.spend)}</span>
            <span className="ml-2">across {summary.totals.count} expense{summary.totals.count === 1 ? '' : 's'}</span>
          </p>
        )}
      </div>

      {summary && summary.totals.count > 0 && (
        <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card title="Spend by category">
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={summary.byCategory} dataKey="spend" nameKey="name" innerRadius={50} outerRadius={90}>
                  {summary.byCategory.map((_, i) => <Cell key={i} fill={SERIES[i % SERIES.length]} />)}
                </Pie>
                <Tooltip formatter={(v: number) => money(v)} />
              </PieChart>
            </ResponsiveContainer>
          </Card>

          <Card title="Spend over time">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={summary.byPeriod} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="label" tick={{ fill: INK_MUTED, fontSize: 12 }} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fill: INK_MUTED, fontSize: 12 }} tickLine={false} axisLine={false} />
                <Tooltip formatter={(v: number) => money(v)} />
                <Bar dataKey="spend" fill={SERIES[0]} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>

          <Card title="Spend by individual">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={summary.byPerson} layout="vertical" margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid stroke={GRID} horizontal={false} />
                <XAxis type="number" tick={{ fill: INK_MUTED, fontSize: 12 }} tickLine={false} />
                <YAxis type="category" dataKey="name" width={100} tick={{ fill: INK_MUTED, fontSize: 12 }} tickLine={false} axisLine={false} />
                <Tooltip formatter={(v: number) => money(v)} />
                <Bar dataKey="spend" fill={SERIES[2]} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-ink/10 bg-white shadow-panel">
        {isLoading ? (
          <p className="px-6 py-8 text-center text-sm text-charcoal/40">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-charcoal/40">
            No partner expenses yet. Submit an expense and choose “Partner expense”.
          </p>
        ) : (
          <>
          {/* Mobile list */}
          <div className="divide-y divide-ink/5 md:hidden">
            {rows.map((r) => (
              <div key={r.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate font-medium text-ink">{r.merchant}</span>
                  <span className="shrink-0 font-semibold text-ink">{money(Number(r.amount))}</span>
                </div>
                <p className="mt-0.5 text-xs text-charcoal/60">
                  {r.date} · {r.user?.name ?? '—'} · {r.category?.name ?? '—'}
                </p>
                {r.paymentMethod && (
                  <p className="mt-0.5 text-xs text-charcoal/60">
                    {r.paymentMethod.label}{r.paymentMethod.lastFour ? ` ····${r.paymentMethod.lastFour}` : ''}
                  </p>
                )}
              </div>
            ))}
          </div>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink/10 bg-brand-50/80 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                <th className="px-6 py-3">Date</th>
                <th className="px-6 py-3">Individual</th>
                <th className="px-6 py-3">Merchant</th>
                <th className="px-6 py-3">Category</th>
                <th className="px-6 py-3">Payment</th>
                <th className="px-6 py-3 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-ink/5 last:border-0">
                  <td className="px-6 py-3 text-charcoal/70">{r.date}</td>
                  <td className="px-6 py-3 text-ink">{r.user?.name ?? '—'}</td>
                  <td className="px-6 py-3 text-ink">{r.merchant}</td>
                  <td className="px-6 py-3 text-charcoal/70">{r.category?.name ?? '—'}</td>
                  <td className="px-6 py-3 text-charcoal/70">
                    {r.paymentMethod ? `${r.paymentMethod.label}${r.paymentMethod.lastFour ? ` ····${r.paymentMethod.lastFour}` : ''}` : '—'}
                  </td>
                  <td className="px-6 py-3 text-right font-semibold tabular-nums text-ink">{money(Number(r.amount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          </>
        )}
      </div>
    </div>
  );
}
