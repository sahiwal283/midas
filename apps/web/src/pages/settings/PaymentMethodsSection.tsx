import { useState, Fragment } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, CreditCard } from 'lucide-react';
import { paymentMethodsApi } from '../../api/expenses';
import { ConfirmModal } from '../../components/ConfirmModal';
import { useAuth } from '../../contexts/AuthContext';
import client from '../../api/client';
import type { PaymentMethod, User } from '../../types';

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

export function PaymentMethodsSection() {
  const qc = useQueryClient();
  const { user } = useAuth();
  // The users list (for the Assignment control) comes from the admin-only
  // /admin/users endpoint — accountants manage cards without per-user lists.
  const isAdmin = user?.role === 'admin' || user?.role === 'developer';

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<PaymentMethod | null>(null);
  const [error, setError] = useState('');
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

  const { data: users = [] } = useQuery<User[]>({
    queryKey: ['admin-users'],
    queryFn: () => client.get('/admin/users').then((r) => r.data.users),
    enabled: isAdmin,
  });
  const userName = (id: string | null) => users.find((u) => u.id === id)?.name ?? 'a specific user';

  function invalidate() {
    qc.invalidateQueries({ queryKey: ['payment-methods-admin'] });
    qc.invalidateQueries({ queryKey: ['payment-methods'] });
  }

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
      invalidate();
      setShowForm(false);
      setError('');
      setForm({
        label: '', lastFour: '', brand: '', zohoAccountName: '', defaultZohoEntity: '',
        requiresReimbursement: false, isCompanyWide: true,
      });
    },
    onError: (err: any) => setError(err?.response?.data?.error?.message ?? 'Could not create payment method'),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => paymentMethodsApi.update(id, { isActive: false }),
    onSuccess: () => {
      invalidate();
      setDeactivateTarget(null);
      setError('');
    },
    onError: (err: any) => {
      setDeactivateTarget(null);
      setError(err?.response?.data?.error?.message ?? 'Could not deactivate payment method');
    },
  });

  function set(key: string, value: string | boolean) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          Manage company cards and payment methods. Employees select these when submitting expenses.
        </p>
        <button
          onClick={() => setShowForm(true)}
          className="flex shrink-0 items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          <Plus className="h-4 w-4" />
          Add Method
        </button>
      </div>

      {error && (
        <div className="flex items-start justify-between gap-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>{error}</span>
          <button onClick={() => setError('')} className="shrink-0 text-xs text-red-500 underline hover:text-red-700">
            Dismiss
          </button>
        </div>
      )}

      {/* Add form */}
      {showForm && (
        <div className="rounded-xl border border-brand-200 bg-brand-50 p-5">
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
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
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
                <th className="px-6 py-3">Assignment</th>
                <th className="px-6 py-3">Status</th>
                <th className="px-6 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {methods.map((pm) => (
                <Fragment key={pm.id}>
                  <tr className="hover:bg-gray-50">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <CreditCard className="h-4 w-4 text-gray-400" />
                        <span className="font-medium text-gray-900">{pm.label}</span>
                        {pm.lastFour && <span className="text-gray-400">···{pm.lastFour}</span>}
                        {pm.requiresReimbursement && (
                          <span className="rounded-full bg-purple-50 px-2 py-0.5 text-xs font-medium text-purple-700">
                            Reimbursable
                          </span>
                        )}
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
                    <td className="px-6 py-4 text-gray-600">
                      {pm.isCompanyWide ? 'Company-wide' : `Assigned to ${userName(pm.assignedUserId)}`}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${pm.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                        {pm.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => setEditingId((id) => (id === pm.id ? null : pm.id))}
                          className="text-xs font-medium text-brand-700 hover:underline"
                        >
                          {editingId === pm.id ? 'Close' : 'Edit'}
                        </button>
                        {pm.isActive && (
                          <button
                            onClick={() => setDeactivateTarget(pm)}
                            disabled={deactivateMutation.isPending}
                            className="text-xs text-gray-400 hover:text-red-600 disabled:opacity-50"
                          >
                            Deactivate
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {editingId === pm.id && (
                    <tr className="bg-gray-50">
                      <td colSpan={7} className="px-6 py-4">
                        <PaymentMethodEditor
                          pm={pm}
                          users={users}
                          canAssign={isAdmin}
                          onClose={() => setEditingId(null)}
                          onSaved={() => { invalidate(); setEditingId(null); setError(''); }}
                          onError={setError}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ConfirmModal
        open={deactivateTarget !== null}
        title={`Deactivate ${deactivateTarget?.label}?`}
        confirmLabel="Deactivate"
        danger
        loading={deactivateMutation.isPending}
        onConfirm={() => deactivateTarget && deactivateMutation.mutate(deactivateTarget.id)}
        onCancel={() => setDeactivateTarget(null)}
      >
        <p>
          Employees will no longer be able to select this payment method for new expenses.
          Existing expenses keep their reference.
        </p>
      </ConfirmModal>
    </div>
  );
}

function PaymentMethodEditor({ pm, users, canAssign, onClose, onSaved, onError }: {
  pm: PaymentMethod;
  users: User[];
  canAssign: boolean;
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [form, setForm] = useState({
    label: pm.label,
    lastFour: pm.lastFour ?? '',
    brand: pm.brand ?? '',
    zohoAccountName: pm.zohoAccountName ?? '',
    defaultZohoEntity: pm.defaultZohoEntity ?? '',
    requiresReimbursement: pm.requiresReimbursement,
    assignment: pm.isCompanyWide ? 'company' : 'assigned',
    assignedUserId: pm.assignedUserId ?? '',
  });

  const saveMutation = useMutation({
    mutationFn: () => paymentMethodsApi.update(pm.id, {
      label: form.label,
      lastFour: form.lastFour || undefined,
      brand: form.brand || undefined,
      zohoAccountName: form.zohoAccountName || undefined,
      defaultZohoEntity: form.defaultZohoEntity || null,
      requiresReimbursement: form.requiresReimbursement,
      ...(canAssign
        ? {
            isCompanyWide: form.assignment === 'company',
            assignedUserId: form.assignment === 'assigned' && form.assignedUserId ? form.assignedUserId : null,
          }
        : {}),
    }),
    onSuccess: onSaved,
    onError: (err: any) => onError(err?.response?.data?.error?.message ?? 'Could not update payment method'),
  });

  function set(key: keyof typeof form, value: string | boolean) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const assignedMissing = canAssign && form.assignment === 'assigned' && !form.assignedUserId;

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Edit — {pm.label}</h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Label *</label>
          <input value={form.label} onChange={(e) => set('label', e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Last 4 digits</label>
          <input
            value={form.lastFour}
            onChange={(e) => set('lastFour', e.target.value.replace(/\D/g, '').slice(0, 4))}
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
          <label className="mb-1 block text-xs font-medium text-gray-700">Zoho paid-through account</label>
          <input
            value={form.zohoAccountName}
            onChange={(e) => set('zohoAccountName', e.target.value)}
            placeholder="Zoho Books paid-through account id"
            className={inputCls}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Default company (Zoho entity)</label>
          <input
            value={form.defaultZohoEntity}
            onChange={(e) => set('defaultZohoEntity', e.target.value)}
            placeholder="e.g. Nirvana Kulture"
            className={inputCls}
          />
        </div>
        <div className="flex items-end pb-2">
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={form.requiresReimbursement}
              onChange={(e) => set('requiresReimbursement', e.target.checked)}
              className="rounded border-gray-300"
            />
            Personal card — needs reimbursement
          </label>
        </div>
      </div>

      {/* Assignment control — needs the admin-only users list */}
      {canAssign ? (
        <div className="rounded-lg border border-gray-200 bg-white p-3">
          <p className="mb-2 text-xs font-medium text-gray-700">Assignment</p>
          <div className="flex flex-wrap items-center gap-5">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="radio"
                name={`assignment-${pm.id}`}
                checked={form.assignment === 'company'}
                onChange={() => set('assignment', 'company')}
                className="border-gray-300"
              />
              Company-wide (everyone sees it)
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="radio"
                name={`assignment-${pm.id}`}
                checked={form.assignment === 'assigned'}
                onChange={() => set('assignment', 'assigned')}
                className="border-gray-300"
              />
              Assigned to
            </label>
            {form.assignment === 'assigned' && (
              <select
                value={form.assignedUserId}
                onChange={(e) => set('assignedUserId', e.target.value)}
                className="w-56 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none"
              >
                <option value="">— Select user —</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            )}
          </div>
          {assignedMissing && (
            <p className="mt-2 text-xs text-amber-600">Pick the user this card is assigned to.</p>
          )}
        </div>
      ) : (
        <p className="text-xs text-gray-500">
          Assignment: {pm.isCompanyWide ? 'company-wide.' : 'assigned to a specific user.'} Only admins can change card assignment.
        </p>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => saveMutation.mutate()}
          disabled={!form.label || assignedMissing || saveMutation.isPending}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {saveMutation.isPending ? 'Saving…' : 'Save changes'}
        </button>
        <button
          onClick={onClose}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
