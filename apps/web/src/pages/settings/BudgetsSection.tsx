import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../../api/client';
import { companyApi } from '../../api/companies';
import { expenseApi } from '../../api/expenses';
import { useAuth } from '../../contexts/AuthContext';

type Budget = {
  id: string;
  companyName: string;
  period: string;
  amount: string;
  categoryId: string | null;
  notes: string | null;
  category?: { id: string; name: string } | null;
};

const inputCls = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none';

export function BudgetsSection() {
  const { user } = useAuth();
  const canEdit = user?.role === 'admin' || user?.role === 'developer';
  const qc = useQueryClient();
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7));
  const [form, setForm] = useState({ companyName: '', amount: '', categoryId: '', notes: '' });
  const [error, setError] = useState('');

  const companies = useQuery({
    queryKey: ['companies'],
    queryFn: () => companyApi.list(),
    staleTime: 60_000,
  });
  const categories = useQuery({
    queryKey: ['expense-categories'],
    queryFn: () => expenseApi.categories(),
    staleTime: 60_000,
  });
  const budgets = useQuery({
    queryKey: ['budgets', period],
    queryFn: async () =>
      (await api.get<{ budgets: Budget[] }>('/budgets', { params: { period } })).data.budgets,
  });

  const create = useMutation({
    mutationFn: async () => {
      await api.post('/budgets', {
        companyName: form.companyName,
        period,
        amount: Number(form.amount),
        categoryId: form.categoryId || null,
        notes: form.notes || null,
      });
    },
    onSuccess: () => {
      setForm({ companyName: '', amount: '', categoryId: '', notes: '' });
      setError('');
      void qc.invalidateQueries({ queryKey: ['budgets'] });
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message;
      setError(msg || 'Failed to save budget');
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => api.delete(`/budgets/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['budgets'] }),
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Budgets</h2>
        <p className="mt-1 text-sm text-gray-500">
          Monthly spend ceilings per company (optional category). Compared on Reports.
        </p>
      </div>

      <label className="block text-sm max-w-xs">
        <span className="text-gray-600">Period</span>
        <input type="month" className={`${inputCls} mt-1`} value={period} onChange={(e) => setPeriod(e.target.value)} />
      </label>

      {error && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</p>}

      {canEdit && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 rounded-xl border border-gray-200 bg-white p-4">
          <label className="text-sm">
            Company
            <select className={`${inputCls} mt-1`} value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })}>
              <option value="">—</option>
              {(companies.data ?? []).map((c) => (
                <option key={c.id} value={c.name}>{c.name}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Amount
            <input className={`${inputCls} mt-1`} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="10000" />
          </label>
          <label className="text-sm">
            Category (optional)
            <select className={`${inputCls} mt-1`} value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
              <option value="">All categories</option>
              {(categories.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <div className="flex items-end">
            <button
              type="button"
              disabled={!form.companyName || !form.amount || create.isPending}
              onClick={() => create.mutate()}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
            >
              Add budget
            </button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {budgets.isLoading ? (
          <p className="p-6 text-sm text-gray-400">Loading…</p>
        ) : (budgets.data ?? []).length === 0 ? (
          <p className="p-6 text-sm text-gray-400">No budgets for {period}.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wider text-gray-500">
                <th className="px-4 py-3">Company</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {(budgets.data ?? []).map((b) => (
                <tr key={b.id}>
                  <td className="px-4 py-3">{b.companyName}</td>
                  <td className="px-4 py-3 text-gray-500">{b.category?.name ?? 'All'}</td>
                  <td className="px-4 py-3 text-right font-medium">${Number(b.amount).toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">
                    {canEdit && (
                      <button
                        type="button"
                        className="text-xs text-red-600 hover:underline"
                        onClick={() => remove.mutate(b.id)}
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
