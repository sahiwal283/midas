import { useEffect, useMemo, useState, Fragment } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, CreditCard, AlertCircle } from 'lucide-react';
import { paymentMethodsApi, expenseApi } from '../../api/expenses';
import { companyApi } from '../../api/companies';
import { ConfirmModal } from '../../components/ConfirmModal';
import { SearchableSelect, type SearchableOption } from '../../components/SearchableSelect';
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

const inputCls = 'w-full rounded-lg border border-gray-300 px-3 py-3 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 lg:py-2';

interface ZohoPaidThroughAccount {
  accountId: string;
  accountName: string;
  accountCode: string | null;
  accountType: string;
}

/** "AMEX Business Platinum Card (-1002)" → { lastFour: '1002', brand: 'amex' } */
export function suggestCardFromZohoAccount(accountName: string): { lastFour: string; brand: string } {
  const digits = accountName.match(/(\d{3,4})\D*$/)?.[1] ?? '';
  const n = accountName.toLowerCase();
  const brand =
    n.includes('amex') || n.includes('american express') ? 'amex'
    : n.includes('visa') ? 'visa'
    : n.includes('master') ? 'mastercard'
    : n.includes('discover') ? 'discover'
    : n.includes('cash') ? 'cash'
    : '';
  return { lastFour: digits.length === 4 ? digits : '', brand };
}

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

  // Company selector → that brand's live Zoho paid-through accounts (bank /
  // credit card / cash), same pattern as the Chart of Accounts section.
  const [company, setCompany] = useState('');
  const { data: companies = [] } = useQuery({
    queryKey: ['companies'],
    queryFn: () => companyApi.list(),
  });
  const zohoCompanies = useMemo(
    () => companies.filter((c) => c.zohoEnabled && c.isActive !== false),
    [companies],
  );
  useEffect(() => {
    if (!company && zohoCompanies.length > 0) setCompany(zohoCompanies[0].name);
  }, [company, zohoCompanies]);

  const {
    data: accountData,
    isFetching: accountsLoading,
    isError: accountsFailed,
  } = useQuery({
    queryKey: ['zoho-paid-through-accounts', company],
    queryFn: () => expenseApi.zohoPaidThroughAccounts(company),
    enabled: !!company,
    staleTime: 60_000,
    retry: 1,
  });
  const accounts: ZohoPaidThroughAccount[] = accountData?.accounts ?? [];
  const accountName = (id: string) => accounts.find((a) => a.accountId === id)?.accountName ?? null;

  /** Account ids already claimed by some payment method (any company). */
  const claimedAccountIds = useMemo(
    () => new Set(methods.map((m) => m.zohoAccountName).filter(Boolean) as string[]),
    [methods],
  );
  const unclaimedAccounts = accounts.filter((a) => !claimedAccountIds.has(a.accountId));

  /**
   * One Zoho account maps to one card. Accounts claimed by OTHER methods are
   * hidden; the row's own mapping stays selectable, as does a saved id Zoho no
   * longer returns (so it never silently disappears).
   */
  const accountOptionsFor = (pm: PaymentMethod): SearchableOption[] => {
    const opts: SearchableOption[] = accounts
      .filter((a) => !claimedAccountIds.has(a.accountId) || pm.zohoAccountName === a.accountId)
      .map((a) => ({
        value: a.accountId,
        label: a.accountName,
        hint: a.accountType.replace(/_/g, ' '),
      }));
    if (pm.zohoAccountName && !opts.some((o) => o.value === pm.zohoAccountName)) {
      opts.unshift({ value: pm.zohoAccountName, label: pm.zohoAccountName, hint: 'not in current Zoho list' });
    }
    return opts;
  };

  const mapMutation = useMutation({
    mutationFn: (v: { id: string; zohoAccountName: string }) =>
      paymentMethodsApi.update(v.id, {
        zohoAccountName: v.zohoAccountName,
        // The paid-through account belongs to this company's Zoho org, so the
        // card's default entity follows the mapping.
        defaultZohoEntity: company,
      }),
    onSuccess: () => { invalidate(); setError(''); },
    onError: (err: any) => setError(err?.response?.data?.error?.message ?? 'Could not save the Zoho mapping'),
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <p className="text-sm text-gray-500">
          Manage company cards and payment methods. Pick a company to match each card to its
          Zoho Books paid-through account — no more copying account ids by hand.
        </p>
        <button
          onClick={() => setShowForm(true)}
          className="flex min-h-11 w-full shrink-0 items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 sm:w-auto lg:min-h-0"
        >
          <Plus className="h-4 w-4" />
          Add Method
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm font-medium text-gray-700" htmlFor="pm-company">Company</label>
        <select
          id="pm-company"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-3 text-sm focus:border-brand-500 focus:outline-none lg:py-2"
        >
          {zohoCompanies.map((c) => (
            <option key={c.id} value={c.name}>{c.name}</option>
          ))}
        </select>
        <span className="text-xs text-gray-400">
          {accountsLoading
            ? 'Loading Zoho accounts…'
            : `${accounts.length} Zoho paid-through accounts · ${unclaimedAccounts.length} not yet linked to a card`}
        </span>
      </div>

      {accountsFailed && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Could not reach Zoho to load this company's paid-through accounts. Existing mappings
            still work; matching is unavailable until Zoho is reachable.
          </span>
        </div>
      )}

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
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
              <label className="mb-1 block text-xs font-medium text-gray-700">Company</label>
              <select
                value={form.defaultZohoEntity}
                onChange={(e) => {
                  set('defaultZohoEntity', e.target.value);
                  // Keep the page's account list in sync so the picker below
                  // always shows this company's Zoho accounts.
                  if (e.target.value) setCompany(e.target.value);
                }}
                className={inputCls}
              >
                <option value="">— Select company —</option>
                {zohoCompanies.map((c) => (
                  <option key={c.id} value={c.name}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Zoho paid-through account</label>
              <SearchableSelect
                options={accounts
                  .filter((a) => !claimedAccountIds.has(a.accountId) || form.zohoAccountName === a.accountId)
                  .map((a) => ({ value: a.accountId, label: a.accountName, hint: a.accountType.replace(/_/g, ' ') }))}
                value={form.zohoAccountName}
                onChange={(id) => set('zohoAccountName', id)}
                placeholder={form.defaultZohoEntity ? 'Search Zoho accounts…' : 'Pick a company first'}
                disabled={!form.defaultZohoEntity || accountsLoading}
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
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <button
              onClick={() => createMutation.mutate()}
              disabled={!form.label || createMutation.isPending}
              className="min-h-11 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60 lg:min-h-0"
            >
              {createMutation.isPending ? 'Saving…' : 'Add Payment Method'}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="min-h-11 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 lg:min-h-0"
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
          <>
            {/* Mobile cards */}
            <div className="divide-y divide-gray-100 md:hidden">
              {methods.map((pm) => (
                <div key={pm.id} className="space-y-3 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <CreditCard className="h-4 w-4 shrink-0 text-gray-400" />
                    <span className="font-medium text-gray-900">{pm.label}</span>
                    {pm.lastFour && <span className="text-gray-400">···{pm.lastFour}</span>}
                    {pm.requiresReimbursement && (
                      <span className="rounded-full bg-purple-50 px-2 py-0.5 text-xs font-medium text-purple-700">
                        Reimbursable
                      </span>
                    )}
                    <span className={`ml-auto inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${pm.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {pm.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
                    <span>{pm.brand ? BRAND_LABELS[pm.brand] ?? pm.brand : 'No brand'}</span>
                    <span aria-hidden="true">·</span>
                    {pm.defaultZohoEntity ? (
                      <span className="inline-flex rounded-full bg-blue-50 px-2 py-0.5 font-medium text-blue-700">
                        {pm.defaultZohoEntity}
                      </span>
                    ) : (
                      <span className="text-gray-400">No company</span>
                    )}
                    <span aria-hidden="true">·</span>
                    <span>{pm.isCompanyWide ? 'Company-wide' : `Assigned to ${userName(pm.assignedUserId)}`}</span>
                  </div>
                  <div>
                    <SearchableSelect
                      options={accountOptionsFor(pm)}
                      value={pm.zohoAccountName ?? ''}
                      onChange={(accountId) => {
                        if (accountId && accountId !== pm.zohoAccountName) {
                          mapMutation.mutate({ id: pm.id, zohoAccountName: accountId });
                        }
                      }}
                      placeholder="Match Zoho account…"
                      disabled={accountsLoading || accountsFailed}
                    />
                    {pm.zohoAccountName && !accountName(pm.zohoAccountName) && !accountsLoading && !accountsFailed && (
                      <p className="mt-1 font-mono text-[11px] text-gray-400">
                        id {pm.zohoAccountName} — not in {company}'s account list
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setEditingId((id) => (id === pm.id ? null : pm.id))}
                      className="min-h-11 flex-1 rounded-lg border border-brand-200 bg-brand-50 text-xs font-medium text-brand-700 hover:bg-brand-100"
                    >
                      {editingId === pm.id ? 'Close' : 'Edit'}
                    </button>
                    {pm.isActive && (
                      <button
                        onClick={() => setDeactivateTarget(pm)}
                        disabled={deactivateMutation.isPending}
                        className="min-h-11 flex-1 rounded-lg border border-gray-200 text-xs font-medium text-gray-500 hover:text-red-600 disabled:opacity-50"
                      >
                        Deactivate
                      </button>
                    )}
                  </div>
                  {editingId === pm.id && (
                    <div className="rounded-lg bg-gray-50 p-3">
                      <PaymentMethodEditor
                        pm={pm}
                        users={users}
                        canAssign={isAdmin}
                        onClose={() => setEditingId(null)}
                        onSaved={() => { invalidate(); setEditingId(null); setError(''); }}
                        onError={setError}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
            <table className="hidden w-full text-sm md:table">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                <th className="px-6 py-3">Label</th>
                <th className="px-6 py-3">Brand</th>
                <th className="px-6 py-3">Company</th>
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
                    <td className="min-w-[16rem] px-6 py-4">
                      <SearchableSelect
                        options={accountOptionsFor(pm)}
                        value={pm.zohoAccountName ?? ''}
                        onChange={(accountId) => {
                          if (accountId && accountId !== pm.zohoAccountName) {
                            mapMutation.mutate({ id: pm.id, zohoAccountName: accountId });
                          }
                        }}
                        placeholder="Match Zoho account…"
                        disabled={accountsLoading || accountsFailed}
                      />
                      {pm.zohoAccountName && !accountName(pm.zohoAccountName) && !accountsLoading && !accountsFailed && (
                        <p className="mt-1 font-mono text-[11px] text-gray-400">
                          id {pm.zohoAccountName} — not in {company}'s account list
                        </p>
                      )}
                    </td>
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
          </>
        )}
      </div>

      {/* Zoho accounts with no Midas card yet — one click prefills the create form */}
      {!accountsLoading && !accountsFailed && unclaimedAccounts.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-gray-700">
            In {company}'s Zoho Books but not in Midas
          </h2>
          <p className="mt-0.5 text-xs text-gray-400">
            Add creates a Midas payment method pre-filled from the Zoho account — review and save.
          </p>
          <ul className="mt-3 divide-y divide-gray-100">
            {unclaimedAccounts.map((a) => (
              <li key={a.accountId} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-gray-800">{a.accountName}</p>
                  <p className="text-xs text-gray-400">{a.accountType.replace(/_/g, ' ')}</p>
                </div>
                <button
                  onClick={() => {
                    const guess = suggestCardFromZohoAccount(a.accountName);
                    setForm({
                      label: a.accountName,
                      lastFour: guess.lastFour,
                      brand: guess.brand,
                      zohoAccountName: a.accountId,
                      defaultZohoEntity: company,
                      requiresReimbursement: false,
                      isCompanyWide: true,
                    });
                    setShowForm(true);
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  className="min-h-11 shrink-0 rounded-lg border border-brand-300 px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-50 lg:min-h-0"
                >
                  + Add to Midas
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

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
          <label className="mb-1 block text-xs font-medium text-gray-700">Default company</label>
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
                className="w-full rounded-lg border border-gray-300 px-3 py-3 text-sm focus:border-brand-500 focus:outline-none sm:w-56 lg:py-1.5"
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

      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          onClick={() => saveMutation.mutate()}
          disabled={!form.label || assignedMissing || saveMutation.isPending}
          className="min-h-11 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60 lg:min-h-0"
        >
          {saveMutation.isPending ? 'Saving…' : 'Save changes'}
        </button>
        <button
          onClick={onClose}
          className="min-h-11 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 lg:min-h-0"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
