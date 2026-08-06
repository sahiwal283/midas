import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, CreditCard } from 'lucide-react';
import { paymentMethodsApi } from '../api/expenses';
import type { PaymentMethod } from '../types';

const BRAND_LABELS: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'Amex',
  discover: 'Discover',
  debit: 'Debit',
  cash: 'Cash',
  other: 'Other',
};

const inputCls = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

export function PaymentMethods() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    label: '',
    lastFour: '',
    brand: '',
    zohoAccountName: '',
    defaultZohoEntity: '',
    requiresReimbursement: false,
    isCompanyWide: true,
  });

  const { data: methods = [], isLoading } = useQuery({
    queryKey: ['payment-methods-admin'],
    queryFn: () => paymentMethodsApi.list(),
  });

  const createMutation = useMutation({
    mutationFn: () => paymentMethodsApi.create({
      label: form.label,
      lastFour: form.lastFour || undefined,
      brand: form.brand || undefined,
      zohoAccountName: form.zohoAccountName || undefined,
      defaultZohoEntity: form.defaultZohoEntity || undefined,
      requiresReimbursement: form.requiresReimbursement,
      isCompanyWide: form.isCompanyWide,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payment-methods-admin'] });
      qc.invalidateQueries({ queryKey: ['payment-methods'] });
      setShowForm(false);
      setForm({
        label: '', lastFour: '', brand: '', zohoAccountName: '', defaultZohoEntity: '',
        requiresReimbursement: false, isCompanyWide: true,
      });
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => paymentMethodsApi.update(id, { isActive: false }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payment-methods-admin'] });
      qc.invalidateQueries({ queryKey: ['payment-methods'] });
    },
  });

  function set(key: string, value: string | boolean) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Payment Methods</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage company cards and payment methods. Employees select these when submitting expenses.
          </p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          <Plus className="h-4 w-4" />
          Add Method
        </button>
      </div>

      {/* Add form */}
      {showForm && (
        <div className="mb-6 rounded-xl border border-brand-200 bg-brand-50 p-5">
          <h2 className="mb-4 text-sm font-semibold text-gray-700">New Payment Method</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Label *</label>
              <input
                value={form.label}
                onChange={(e) => set('label', e.target.value)}
                placeholder="Amex Corporate Card"
                className={inputCls}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Last 4 digits</label>
              <input
                value={form.lastFour}
                onChange={(e) => set('lastFour', e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="1234"
                maxLength={4}
                className={inputCls}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Card brand</label>
              <select value={form.brand} onChange={(e) => set('brand', e.target.value)} className={inputCls}>
                <option value="">— Select brand —</option>
                {Object.entries(BRAND_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Zoho payment account ID / name</label>
              <input
                value={form.zohoAccountName}
                onChange={(e) => set('zohoAccountName', e.target.value)}
                placeholder="Zoho Books paid-through account id"
                className={inputCls}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Default Zoho entity</label>
              <input
                value={form.defaultZohoEntity}
                onChange={(e) => set('defaultZohoEntity', e.target.value)}
                placeholder="e.g. Nirvana Kulture"
                className={inputCls}
              />
            </div>
          </div>
          <div className="mt-3 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="company-wide"
                checked={form.isCompanyWide}
                onChange={(e) => set('isCompanyWide', e.target.checked)}
                className="rounded border-gray-300"
              />
              <label htmlFor="company-wide" className="text-sm text-gray-700">Visible to all employees</label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="requires-reimb"
                checked={form.requiresReimbursement}
                onChange={(e) => set('requiresReimbursement', e.target.checked)}
                className="rounded border-gray-300"
              />
              <label htmlFor="requires-reimb" className="text-sm text-gray-700">
                Personal card — expenses need reimbursement
              </label>
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <button
              onClick={() => createMutation.mutate()}
              disabled={!form.label || createMutation.isPending}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
            >
              {createMutation.isPending ? 'Saving…' : 'Add Payment Method'}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Methods list */}
      <div className="rounded-xl border border-gray-200 bg-white">
        {isLoading ? (
          <div className="px-6 py-12 text-center text-sm text-gray-400">Loading…</div>
        ) : methods.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <CreditCard className="mx-auto mb-3 h-8 w-8 text-gray-300" />
            <p className="text-sm text-gray-500">No payment methods yet.</p>
            <p className="mt-1 text-xs text-gray-400">Add company cards so employees can tag expenses correctly.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                <th className="px-6 py-3">Label</th>
                <th className="px-6 py-3">Brand</th>
                <th className="px-6 py-3">Entity</th>
                <th className="px-6 py-3">Zoho Account</th>
                <th className="px-6 py-3">Scope</th>
                <th className="px-6 py-3">Status</th>
                <th className="px-6 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {methods.map((pm) => (
                <tr key={pm.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <CreditCard className="h-4 w-4 text-gray-400" />
                      <span className="font-medium text-gray-900">{pm.label}</span>
                      {pm.lastFour && <span className="text-gray-400">···{pm.lastFour}</span>}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-gray-600">{pm.brand ? BRAND_LABELS[pm.brand] ?? pm.brand : '—'}</td>
                  <td className="px-6 py-4">
                    {pm.defaultZohoEntity ? (
                      <span className="inline-flex rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                        {pm.defaultZohoEntity}
                      </span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-6 py-4 font-mono text-xs text-gray-600">{pm.zohoAccountName ?? '—'}</td>
                  <td className="px-6 py-4 text-gray-600">{pm.isCompanyWide ? 'Company-wide' : 'Assigned'}</td>
                  <td className="px-6 py-4">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${pm.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {pm.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    {pm.isActive && (
                      <button
                        onClick={() => deactivateMutation.mutate(pm.id)}
                        disabled={deactivateMutation.isPending}
                        className="text-xs text-gray-400 hover:text-red-600 disabled:opacity-50"
                      >
                        Deactivate
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
