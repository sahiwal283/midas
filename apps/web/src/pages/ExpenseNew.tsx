import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { expenseApi } from '../api/expenses';

export function ExpenseNew() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    merchant: '',
    amount: '',
    date: new Date().toISOString().slice(0, 10),
    currency: 'USD',
    categoryId: '',
    paymentMethodId: '',
    description: '',
  });
  const [error, setError] = useState('');

  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: () => expenseApi.categories(),
  });

  const { data: paymentMethods = [] } = useQuery({
    queryKey: ['payment-methods'],
    queryFn: () => expenseApi.paymentMethods(),
  });

  const mutation = useMutation({
    mutationFn: () => expenseApi.create({
      merchant: form.merchant,
      amount: Number(form.amount),
      date: form.date,
      currency: form.currency,
      categoryId: form.categoryId || undefined,
      paymentMethodId: form.paymentMethodId || undefined,
      description: form.description || undefined,
    }),
    onSuccess: (expense) => {
      qc.invalidateQueries({ queryKey: ['expenses'] });
      navigate(`/expenses/${expense.id}`);
    },
    onError: () => setError('Failed to create expense. Please try again.'),
  });

  function set(key: string, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!form.merchant || !form.amount || !form.date) return;
    mutation.mutate();
  }

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">New Expense</h1>
        <p className="mt-1 text-sm text-gray-500">Saved as a draft — submit when ready for accountant review.</p>
      </div>

      <div className="max-w-xl rounded-xl border border-gray-200 bg-white p-6">
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Merchant *">
            <input
              required
              value={form.merchant}
              onChange={(e) => set('merchant', e.target.value)}
              placeholder="Coffee Shop, Airline, etc."
              className={inputCls}
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Amount *">
              <input
                required
                type="number"
                min="0.01"
                step="0.01"
                value={form.amount}
                onChange={(e) => set('amount', e.target.value)}
                placeholder="0.00"
                className={inputCls}
              />
            </Field>
            <Field label="Currency">
              <select value={form.currency} onChange={(e) => set('currency', e.target.value)} className={inputCls}>
                <option>USD</option>
                <option>EUR</option>
                <option>GBP</option>
                <option>CAD</option>
                <option>MXN</option>
              </select>
            </Field>
          </div>

          <Field label="Date *">
            <input
              required
              type="date"
              value={form.date}
              onChange={(e) => set('date', e.target.value)}
              className={inputCls}
            />
          </Field>

          <Field label="Category">
            <select value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)} className={inputCls}>
              <option value="">— Select a category —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>

          {paymentMethods.length > 0 && (
            <Field label="Payment method">
              <select value={form.paymentMethodId} onChange={(e) => set('paymentMethodId', e.target.value)} className={inputCls}>
                <option value="">— Select a payment method —</option>
                {paymentMethods.map((pm) => (
                  <option key={pm.id} value={pm.id}>
                    {pm.label}{pm.lastFour ? ` ···${pm.lastFour}` : ''}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label="Description">
            <textarea
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              rows={3}
              placeholder="Optional notes about this expense"
              className={`${inputCls} resize-none`}
            />
          </Field>

          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={mutation.isPending}
              className="rounded-lg bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
            >
              {mutation.isPending ? 'Saving…' : 'Save Draft'}
            </button>
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="rounded-lg border border-gray-300 px-5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const inputCls = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700">{label}</label>
      {children}
    </div>
  );
}
