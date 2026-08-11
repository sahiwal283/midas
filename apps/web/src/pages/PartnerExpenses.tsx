import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell,
} from 'recharts';
import client from '../api/client';

/** Same fixed-slot palette as the Reports page so both read as one system. */
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const GRID = '#f3f4f6';
const INK_MUTED = '#6b7280';

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
    <div className="p-4 lg:p-8">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold text-ink">Partner Expenses</h1>
        <p className="mt-1 text-sm text-charcoal/55">
          Spend marked as partner expenses. Not sent to accounting or Zoho.
        </p>
      </div>

      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-charcoal/60" htmlFor="pe-from">From</label>
          <input id="pe-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="rounded-lg border border-ink/15 px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-charcoal/60" htmlFor="pe-to">To</label>
          <input id="pe-to" type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="rounded-lg border border-ink/15 px-3 py-2 text-sm" />
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
                <XAxis dataKey="label" tick={{ fill: INK_MUTED, fontSize: 12 }} tickLine={false} />
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
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink/10 text-left text-xs font-semibold uppercase tracking-wider text-charcoal/45">
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
                  <td className="px-6 py-3 text-right font-semibold text-ink">{money(Number(r.amount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
