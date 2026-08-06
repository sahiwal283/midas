import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { partnerExpenseApi } from '../api/partnerExpenses';
import type { PartnerExpenseCategory } from '../types';

function CategoryBadge({ category }: { category: PartnerExpenseCategory }) {
  return category === 'business' ? (
    <span className="inline-block rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700">Business</span>
  ) : (
    <span className="inline-block rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600">Personal</span>
  );
}

export function PartnerExpenses() {
  const qc = useQueryClient();
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['partner-expenses'],
    queryFn: () => partnerExpenseApi.list(),
  });

  const [formOpen, setFormOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [itemLocation, setItemLocation] = useState('');
  const [category, setCategory] = useState<PartnerExpenseCategory>('business');
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () =>
      partnerExpenseApi.create({ amount: Number(amount), itemLocation: itemLocation.trim(), category }),
    onSuccess: () => {
      setAmount('');
      setItemLocation('');
      setCategory('business');
      setFormOpen(false);
      setError(null);
      void qc.invalidateQueries({ queryKey: ['partner-expenses'] });
    },
    onError: () => setError('Could not save the expense. Check the fields and try again.'),
  });

  const total = useMemo(() => rows.reduce((sum, r) => sum + Number(r.amount || 0), 0), [rows]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('Enter an amount greater than 0.');
      return;
    }
    if (!itemLocation.trim()) {
      setError('Enter an item or location.');
      return;
    }
    setError(null);
    createMutation.mutate();
  }

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-gray-900">Partner Expenses</h1>
        <button
          type="button"
          onClick={() => setFormOpen((o) => !o)}
          className="flex shrink-0 items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          <Plus className="h-4 w-4" />
          New Partner Expense
        </button>
      </div>

      {!isLoading && rows.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
            <p className="text-xs font-medium text-gray-500">Total logged</p>
            <p className="mt-0.5 text-xl font-bold text-gray-900">
              ${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
            <p className="text-xs font-medium text-gray-500">Entries</p>
            <p className="mt-0.5 text-xl font-bold text-gray-900">{rows.length}</p>
          </div>
        </div>
      )}

      {formOpen && (
        <form onSubmit={submit} className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="w-full sm:w-40">
              <label className="mb-1 block text-xs font-medium text-gray-500">Amount</label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                required
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-gray-500">Item / Location</label>
              <input
                type="text"
                value={itemLocation}
                onChange={(e) => setItemLocation(e.target.value)}
                placeholder="e.g. Dinner — Las Vegas"
                required
                maxLength={300}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Category</label>
              <div className="flex rounded-lg border border-gray-200 bg-gray-100 p-1">
                {(['business', 'personal'] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategory(c)}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
                      category === c ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {createMutation.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </form>
      )}

      <div className="rounded-xl border border-gray-200 bg-white">
        {isLoading ? (
          <div className="px-6 py-12 text-center text-sm text-gray-400">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-gray-500">
            No partner expenses yet. Log the first one with “New Partner Expense”.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                <th className="px-6 py-3">User</th>
                <th className="px-6 py-3 text-right">Amount</th>
                <th className="px-6 py-3">Item / Location</th>
                <th className="px-6 py-3">Category</th>
                <th className="px-6 py-3">Logged</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 font-medium text-gray-900">{r.userName}</td>
                  <td className="px-6 py-4 text-right font-medium text-gray-900">${Number(r.amount).toFixed(2)}</td>
                  <td className="px-6 py-4 text-gray-600">{r.itemLocation}</td>
                  <td className="px-6 py-4"><CategoryBadge category={r.category} /></td>
                  <td className="px-6 py-4 text-gray-600">{new Date(r.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
