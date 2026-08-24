import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, CreditCard, AlertCircle } from 'lucide-react';
import { paymentMethodsApi, expenseApi } from '../../api/expenses';
import { companyApi } from '../../api/companies';
import { ConfirmModal } from '../../components/ConfirmModal';
import { SearchableSelect, type SearchableOption } from '../../components/SearchableSelect';
import { useAuth } from '../../contexts/AuthContext';
import client from '../../api/client';
import type { PaymentMethod, User } from '../../types';
import {
  groupPaymentMethodsForCompany,
  patchForCompanyMove,
  countCardsPerZohoAccount,
  shareHintFor,
} from '@midas/shared';

const BRAND_LABELS: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'Amex',
  discover: 'Discover',
  debit: 'Debit',
  cash: 'Cash',
  other: 'Other',
};

interface CompanyAccounts {
  accounts: ZohoPaidThroughAccount[];
  loading: boolean;
  failed: boolean;
}
const EMPTY_ACCOUNTS: CompanyAccounts = { accounts: [], loading: false, failed: false };

const inputCls = 'w-full rounded-lg border border-ink/15 px-3 py-3 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 lg:py-2';

function CompanySelect({
  value,
  companies,
  onChange,
  disabled,
}: {
  value: string | null;
  companies: Array<{ id: string; name: string }>;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  return (
    <select
      value={value ?? ''}
      disabled={disabled}
      aria-label="Company"
      onChange={(e) => onChange(e.target.value)}
      className="min-h-11 w-full max-w-[14rem] rounded-lg border border-ink/15 bg-white px-2 py-1.5 text-xs font-medium text-ink focus:border-brand-500 focus:outline-none disabled:opacity-60 lg:min-h-0"
    >
      <option value="">Unassigned</option>
      {companies.map((c) => (
        <option key={c.id} value={c.name}>{c.name}</option>
      ))}
    </select>
  );
}

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

  // Accounts are fetched per company, so a card's picker always shows its OWN
  // company's accounts rather than whichever company the page selector happens
  // to be on. React Query dedupes and caches, so a company already loaded is free.
  const neededCompanies = useMemo(() => {
    const names = new Set<string>();
    if (company) names.add(company);
    if (form.defaultZohoEntity) names.add(form.defaultZohoEntity);
    return [...names];
  }, [company, form.defaultZohoEntity]);

  const accountQueries = useQueries({
    queries: neededCompanies.map((name) => ({
      queryKey: ['zoho-paid-through-accounts', name],
      queryFn: () => expenseApi.zohoPaidThroughAccounts(name),
      staleTime: 60_000,
      retry: 1,
    })),
  });

  const accountsByCompany = new Map<string, CompanyAccounts>(
    neededCompanies.map((name, i) => {
      const q = accountQueries[i];
      return [name, {
        accounts: q?.data?.accounts ?? [],
        loading: !!q?.isFetching,
        failed: !!q?.isError,
      }];
    }),
  );

  const accountsFor = (name: string | null | undefined): CompanyAccounts =>
    (name && accountsByCompany.get(name)) || EMPTY_ACCOUNTS;

  /** A saved mapping the card's own company does not list — stale, not cross-company. */
  const rowMismatch = (pm: PaymentMethod): boolean => {
    if (!pm.zohoAccountName || !pm.defaultZohoEntity) return false;
    const { accounts: list, loading, failed } = accountsFor(pm.defaultZohoEntity);
    if (loading || failed) return false;
    return !list.some((a) => a.accountId === pm.zohoAccountName);
  };

  // The page-level selector still drives the summary line and the "in Zoho but
  // not in Midas" list — both describe the company you are browsing, not a card.
  const {
    accounts,
    loading: accountsLoading,
    failed: accountsFailed,
  } = accountsFor(company);
  const accountName = (id: string) => accounts.find((a) => a.accountId === id)?.accountName ?? null;

  const { belonging, unassigned } = useMemo(
    () => groupPaymentMethodsForCompany(methods, company),
    [methods, company],
  );

  /** How many cards point at each account — several may share one. */
  const cardsPerAccount = useMemo(() => countCardsPerZohoAccount(methods), [methods]);
  /** Accounts no card points at yet. Drives the summary and the add-list. */
  const unclaimedAccounts = accounts.filter((a) => !cardsPerAccount.has(a.accountId));

  /**
   * Several cards may map to one Zoho account — three physical PNC cards on one
   * PNC credit line, say — so nothing is filtered out; the hint says what an
   * account is already used by. A saved id Zoho no longer returns is kept as an
   * option so it never silently disappears.
   */
  const accountOptionsFor = (pm: PaymentMethod): SearchableOption[] => {
    const opts: SearchableOption[] = accountsFor(pm.defaultZohoEntity).accounts
      .map((a) => {
        const share = shareHintFor(cardsPerAccount, a.accountId, pm.zohoAccountName);
        const type = a.accountType.replace(/_/g, ' ');
        return {
          value: a.accountId,
          label: a.accountName,
          hint: share ? `${type} · ${share}` : type,
        };
      });
    if (pm.zohoAccountName && !opts.some((o) => o.value === pm.zohoAccountName)) {
      opts.unshift({ value: pm.zohoAccountName, label: pm.zohoAccountName, hint: 'not in current Zoho list' });
    }
    return opts;
  };

  const mapMutation = useMutation({
    mutationFn: (v: { id: string; zohoAccountName: string }) =>
      paymentMethodsApi.update(v.id, {
        zohoAccountName: v.zohoAccountName,
      }),
    onSuccess: () => { invalidate(); setError(''); },
    onError: (err: any) => setError(err?.response?.data?.error?.message ?? 'Could not save the Zoho mapping'),
  });

  const moveMutation = useMutation({
    mutationFn: (v: { id: string; defaultZohoEntity: string | null; zohoAccountName?: null }) =>
      paymentMethodsApi.update(v.id, {
        defaultZohoEntity: v.defaultZohoEntity,
        ...(v.zohoAccountName === null ? { zohoAccountName: null } : {}),
      }),
    onSuccess: () => { invalidate(); setError(''); },
    onError: (err: any) => setError(err?.response?.data?.error?.message ?? 'Could not move this card'),
  });

  function moveToCompany(pm: PaymentMethod, nextEntity: string) {
    const patch = patchForCompanyMove(pm, nextEntity);
    moveMutation.mutate({ id: pm.id, ...patch });
  }

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
        label: '', lastFour: '', brand: '', zohoAccountName: '', defaultZohoEntity: company,
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
        <p className="text-sm text-muted">
          Cards for this company, plus unassigned cards you can attach. Other companies are hidden —
          switch the dropdown to work those lists.
        </p>
        <button
          onClick={() => {
            setForm((f) => ({ ...f, defaultZohoEntity: company }));
            setShowForm(true);
          }}
          className="flex min-h-11 w-full shrink-0 items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-cream hover:bg-brand-700 sm:w-auto lg:min-h-0"
        >
          <Plus className="h-4 w-4" />
          Add Method
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm font-medium text-charcoal/80" htmlFor="pm-company">Company</label>
        <select
          id="pm-company"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          className="rounded-lg border border-ink/15 px-3 py-3 text-sm focus:border-brand-500 focus:outline-none lg:py-2"
        >
          {zohoCompanies.map((c) => (
            <option key={c.id} value={c.name}>{c.name}</option>
          ))}
        </select>
        <span className="text-xs text-charcoal/40">
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
        <div className="flex items-start justify-between gap-4 rounded-lg border border-danger/25 bg-danger/10 px-4 py-3 text-sm text-danger">
          <span>{error}</span>
          <button onClick={() => setError('')} className="shrink-0 text-xs text-danger underline hover:text-danger">
            Dismiss
          </button>
        </div>
      )}

      {/* Add form */}
      {showForm && (
        <div className="rounded-xl border border-brand-200 bg-brand-50 p-5">
          <h2 className="mb-4 text-sm font-semibold text-charcoal/80">New Payment Method</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-charcoal/80">Label *</label>
              <input
                value={form.label}
                onChange={(e) => set('label', e.target.value)}
                placeholder="Amex Corporate Card"
                className={inputCls}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-charcoal/80">Last 4 digits</label>
              <input
                value={form.lastFour}
                onChange={(e) => set('lastFour', e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="1234"
                maxLength={4}
                className={inputCls}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-charcoal/80">Card brand</label>
              <select value={form.brand} onChange={(e) => set('brand', e.target.value)} className={inputCls}>
                <option value="">— Select brand —</option>
                {Object.entries(BRAND_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-charcoal/80">Company</label>
              <select
                value={form.defaultZohoEntity}
                onChange={(e) => {
                  set('defaultZohoEntity', e.target.value);
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
              <label className="mb-1 block text-xs font-medium text-charcoal/80">Zoho paid-through account</label>
              <SearchableSelect
                options={accountsFor(form.defaultZohoEntity).accounts.map((a) => {
                  const share = shareHintFor(cardsPerAccount, a.accountId, form.zohoAccountName || null);
                  const type = a.accountType.replace(/_/g, ' ');
                  return {
                    value: a.accountId,
                    label: a.accountName,
                    hint: share ? `${type} · ${share}` : type,
                  };
                })}
                value={form.zohoAccountName}
                onChange={(id) => set('zohoAccountName', id)}
                placeholder={form.defaultZohoEntity ? 'Search Zoho accounts…' : 'Pick a company first'}
                disabled={!form.defaultZohoEntity || accountsFor(form.defaultZohoEntity).loading}
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
                className="rounded border-ink/15"
              />
              <label htmlFor="company-wide" className="text-sm text-charcoal/80">Visible to all employees</label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="requires-reimb"
                checked={form.requiresReimbursement}
                onChange={(e) => set('requiresReimbursement', e.target.checked)}
                className="rounded border-ink/15"
              />
              <label htmlFor="requires-reimb" className="text-sm text-charcoal/80">
                Personal card — expenses need reimbursement
              </label>
            </div>
          </div>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <button
              onClick={() => createMutation.mutate()}
              disabled={!form.label || createMutation.isPending}
              className="min-h-11 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-cream hover:bg-brand-700 disabled:opacity-60 lg:min-h-0"
            >
              {createMutation.isPending ? 'Saving…' : 'Add Payment Method'}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="min-h-11 rounded-lg border border-ink/15 px-4 py-2 text-sm font-medium text-charcoal/80 hover:bg-ink/[0.03] lg:min-h-0"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Methods list */}
      <div className="overflow-x-auto rounded-xl border border-ink/10 bg-white">
        {isLoading ? (
          <div className="px-6 py-12 text-center text-sm text-charcoal/40">Loading…</div>
        ) : methods.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <CreditCard className="mx-auto mb-3 h-8 w-8 text-charcoal/25" />
            <p className="text-sm text-muted">No payment methods yet.</p>
            <p className="mt-1 text-xs text-charcoal/40">Add company cards so employees can tag expenses correctly.</p>
          </div>
        ) : belonging.length === 0 && unassigned.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-sm text-muted">No cards for {company} yet.</p>
            <p className="mt-1 text-xs text-charcoal/40">Unassigned cards appear here. Switch company to see other brands.</p>
          </div>
        ) : (
          <>
            {/* Mobile cards */}
            <div className="divide-y divide-ink/5 md:hidden">
              {belonging.length > 0 && (
                <p className="bg-brand-50/80 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                  {company}
                </p>
              )}
              {belonging.map((pm) => (
                <MethodCard
                  key={pm.id}
                  pm={pm}
                  userName={userName}
                  accountOptions={accountOptionsFor(pm)}
                  zohoDisabled={!pm.defaultZohoEntity || accountsFor(pm.defaultZohoEntity).loading || accountsFor(pm.defaultZohoEntity).failed}
                  zohoMismatch={rowMismatch(pm)}
                  companyLabel={pm.defaultZohoEntity ?? company}
                  companies={zohoCompanies}
                  editing={editingId === pm.id}
                  isAdmin={isAdmin}
                  users={users}
                  deactivatePending={deactivateMutation.isPending || moveMutation.isPending}
                  onMove={(next) => moveToCompany(pm, next)}
                  onMap={(accountId) => mapMutation.mutate({ id: pm.id, zohoAccountName: accountId })}
                  onToggleEdit={() => setEditingId((id) => (id === pm.id ? null : pm.id))}
                  onDeactivate={() => setDeactivateTarget(pm)}
                  onCloseEdit={() => setEditingId(null)}
                  onSaved={() => { invalidate(); setEditingId(null); setError(''); }}
                  onError={setError}
                />
              ))}
              {unassigned.length > 0 && (
                <p className="bg-brand-50/80 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                  Unassigned
                </p>
              )}
              {unassigned.map((pm) => (
                <MethodCard
                  key={pm.id}
                  pm={pm}
                  userName={userName}
                  accountOptions={accountOptionsFor(pm)}
                  zohoDisabled
                  zohoMismatch={false}
                  companyLabel={pm.defaultZohoEntity ?? company}
                  companies={zohoCompanies}
                  editing={editingId === pm.id}
                  isAdmin={isAdmin}
                  users={users}
                  deactivatePending={deactivateMutation.isPending || moveMutation.isPending}
                  onMove={(next) => moveToCompany(pm, next)}
                  onMap={(accountId) => mapMutation.mutate({ id: pm.id, zohoAccountName: accountId })}
                  onToggleEdit={() => setEditingId((id) => (id === pm.id ? null : pm.id))}
                  onDeactivate={() => setDeactivateTarget(pm)}
                  onCloseEdit={() => setEditingId(null)}
                  onSaved={() => { invalidate(); setEditingId(null); setError(''); }}
                  onError={setError}
                />
              ))}
            </div>
            <table className="hidden w-full table-fixed text-sm md:table">
            <thead>
              <tr className="border-b border-ink/10 bg-brand-50/80 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                <th className="w-[34%] px-4 py-3">Card</th>
                <th className="w-[18%] px-4 py-3">Company</th>
                <th className="w-[33%] px-4 py-3">Zoho Account</th>
                <th className="w-[15%] px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {belonging.length > 0 && (
                <tr>
                  <td colSpan={4} className="bg-brand-50/50 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                    {company}
                  </td>
                </tr>
              )}
              {belonging.map((pm) => (
                <MethodTableRows
                  key={pm.id}
                  pm={pm}
                  userName={userName}
                  accountOptions={accountOptionsFor(pm)}
                  zohoDisabled={!pm.defaultZohoEntity || accountsFor(pm.defaultZohoEntity).loading || accountsFor(pm.defaultZohoEntity).failed}
                  zohoMismatch={rowMismatch(pm)}
                  companyLabel={pm.defaultZohoEntity ?? company}
                  companies={zohoCompanies}
                  editing={editingId === pm.id}
                  isAdmin={isAdmin}
                  users={users}
                  deactivatePending={deactivateMutation.isPending || moveMutation.isPending}
                  onMove={(next) => moveToCompany(pm, next)}
                  onMap={(accountId) => mapMutation.mutate({ id: pm.id, zohoAccountName: accountId })}
                  onToggleEdit={() => setEditingId((id) => (id === pm.id ? null : pm.id))}
                  onDeactivate={() => setDeactivateTarget(pm)}
                  onCloseEdit={() => setEditingId(null)}
                  onSaved={() => { invalidate(); setEditingId(null); setError(''); }}
                  onError={setError}
                />
              ))}
              {unassigned.length > 0 && (
                <tr>
                  <td colSpan={4} className="bg-brand-50/50 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                    Unassigned — attach to {company} or leave personal
                  </td>
                </tr>
              )}
              {unassigned.map((pm) => (
                <MethodTableRows
                  key={pm.id}
                  pm={pm}
                  userName={userName}
                  accountOptions={accountOptionsFor(pm)}
                  zohoDisabled
                  zohoMismatch={false}
                  companyLabel={pm.defaultZohoEntity ?? company}
                  companies={zohoCompanies}
                  editing={editingId === pm.id}
                  isAdmin={isAdmin}
                  users={users}
                  deactivatePending={deactivateMutation.isPending || moveMutation.isPending}
                  onMove={(next) => moveToCompany(pm, next)}
                  onMap={(accountId) => mapMutation.mutate({ id: pm.id, zohoAccountName: accountId })}
                  onToggleEdit={() => setEditingId((id) => (id === pm.id ? null : pm.id))}
                  onDeactivate={() => setDeactivateTarget(pm)}
                  onCloseEdit={() => setEditingId(null)}
                  onSaved={() => { invalidate(); setEditingId(null); setError(''); }}
                  onError={setError}
                />
              ))}
            </tbody>
            </table>
          </>
        )}
      </div>

      {/* Zoho accounts with no Midas card yet — one click prefills the create form */}
      {!accountsLoading && !accountsFailed && unclaimedAccounts.length > 0 && (
        <div className="rounded-xl border border-ink/10 bg-white p-5">
          <h2 className="text-sm font-semibold text-charcoal/80">
            In {company}'s Zoho Books but not in Midas
          </h2>
          <p className="mt-0.5 text-xs text-charcoal/40">
            Add creates a Midas payment method pre-filled from the Zoho account — review and save.
          </p>
          <ul className="mt-3 divide-y divide-ink/5">
            {unclaimedAccounts.map((a) => (
              <li key={a.accountId} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">{a.accountName}</p>
                  <p className="text-xs text-charcoal/40">{a.accountType.replace(/_/g, ' ')}</p>
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

interface MethodViewProps {
  pm: PaymentMethod;
  userName: (id: string | null) => string;
  accountOptions: SearchableOption[];
  zohoDisabled: boolean;
  zohoMismatch: boolean;
  companyLabel: string;
  companies: Array<{ id: string; name: string }>;
  editing: boolean;
  isAdmin: boolean;
  users: User[];
  deactivatePending: boolean;
  onMove: (next: string) => void;
  onMap: (accountId: string) => void;
  onToggleEdit: () => void;
  onDeactivate: () => void;
  onCloseEdit: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}

function MethodCard(props: MethodViewProps) {
  const { pm, userName, accountOptions, zohoDisabled, zohoMismatch, companyLabel, companies, editing, isAdmin, users, deactivatePending } = props;
  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <CreditCard className="h-4 w-4 shrink-0 text-charcoal/40" />
        <span className="font-medium text-ink">{pm.label}</span>
        {pm.lastFour && <span className="text-charcoal/40">···{pm.lastFour}</span>}
        {pm.requiresReimbursement && (
          <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
            Reimbursable
          </span>
        )}
        <span className={`ml-auto inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${pm.isActive ? 'bg-success/15 text-success' : 'bg-brand-50 text-muted'}`}>
          {pm.isActive ? 'Active' : 'Inactive'}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-charcoal/70">
        <span>{pm.brand ? BRAND_LABELS[pm.brand] ?? pm.brand : 'No brand'}</span>
        <span aria-hidden="true">·</span>
        <span>{pm.isCompanyWide ? 'Company-wide' : `Assigned to ${userName(pm.assignedUserId)}`}</span>
      </div>
      <CompanySelect
        value={pm.defaultZohoEntity}
        companies={companies}
        onChange={props.onMove}
        disabled={deactivatePending}
      />
      <div>
        <SearchableSelect
          options={accountOptions}
          value={pm.zohoAccountName ?? ''}
          onChange={(accountId) => {
            if (accountId && accountId !== pm.zohoAccountName) props.onMap(accountId);
          }}
          placeholder={pm.defaultZohoEntity ? 'Match Zoho account…' : 'Assign a company first'}
          disabled={zohoDisabled}
        />
        {zohoMismatch && (
          <p className="mt-1 font-mono text-[11px] text-danger">
            id {pm.zohoAccountName} — not in {companyLabel}&apos;s account list
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={props.onToggleEdit}
          className="min-h-11 flex-1 rounded-lg border border-brand-200 bg-brand-50 text-xs font-medium text-brand-700 hover:bg-brand-100"
        >
          {editing ? 'Close' : 'Edit'}
        </button>
        {pm.isActive && (
          <button
            type="button"
            onClick={props.onDeactivate}
            disabled={deactivatePending}
            className="min-h-11 flex-1 rounded-lg border border-ink/10 text-xs font-medium text-muted hover:text-danger disabled:opacity-50"
          >
            Deactivate
          </button>
        )}
      </div>
      {editing && (
        <div className="rounded-lg bg-cream p-3">
          <PaymentMethodEditor
            pm={pm}
            users={users}
            companies={companies}
            canAssign={isAdmin}
            onClose={props.onCloseEdit}
            onSaved={props.onSaved}
            onError={props.onError}
          />
        </div>
      )}
    </div>
  );
}

function MethodTableRows(props: MethodViewProps) {
  const { pm, userName, accountOptions, zohoDisabled, zohoMismatch, companyLabel, companies, editing, isAdmin, users, deactivatePending } = props;
  return (
    <>
      <tr className="hover:bg-ink/[0.03]">
        <td className="px-4 py-4 align-top">
          <div className="flex items-start gap-2">
            <CreditCard className="mt-0.5 h-4 w-4 shrink-0 text-charcoal/40" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium text-ink">{pm.label}</span>
                {pm.lastFour && <span className="text-charcoal/40">···{pm.lastFour}</span>}
                {pm.requiresReimbursement && (
                  <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
                    Reimbursable
                  </span>
                )}
              </div>
              {/* Brand and assignment ride here rather than in columns of their
                  own — the same sub-line the mobile card view already shows. */}
              <p className="mt-0.5 truncate text-xs text-charcoal/70">
                {pm.brand ? BRAND_LABELS[pm.brand] ?? pm.brand : 'No brand'}
                {' · '}
                {pm.isCompanyWide ? 'Company-wide' : `Assigned to ${userName(pm.assignedUserId)}`}
              </p>
            </div>
          </div>
        </td>
        <td className="px-4 py-4 align-top">
          <CompanySelect
            value={pm.defaultZohoEntity}
            companies={companies}
            onChange={props.onMove}
            disabled={deactivatePending}
          />
        </td>
        <td className="px-4 py-4 align-top">
          <SearchableSelect
            options={accountOptions}
            value={pm.zohoAccountName ?? ''}
            onChange={(accountId) => {
              if (accountId && accountId !== pm.zohoAccountName) props.onMap(accountId);
            }}
            placeholder={pm.defaultZohoEntity ? 'Match Zoho account…' : 'Assign a company first'}
            disabled={zohoDisabled}
          />
          {zohoMismatch && (
            <p className="mt-1 font-mono text-[11px] text-danger">
              id {pm.zohoAccountName} — not in {companyLabel}&apos;s account list
            </p>
          )}
        </td>
        <td className="px-4 py-4 align-top">
          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${pm.isActive ? 'bg-success/15 text-success' : 'bg-brand-50 text-muted'}`}>
            {pm.isActive ? 'Active' : 'Inactive'}
          </span>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <button
              type="button"
              onClick={props.onToggleEdit}
              className="text-xs font-medium text-brand-700 hover:underline"
            >
              {editing ? 'Close' : 'Edit'}
            </button>
            {pm.isActive && (
              <button
                type="button"
                onClick={props.onDeactivate}
                disabled={deactivatePending}
                className="text-xs text-charcoal/40 hover:text-danger disabled:opacity-50"
              >
                Deactivate
              </button>
            )}
          </div>
        </td>
      </tr>
      {editing && (
        <tr className="bg-cream">
          <td colSpan={4} className="px-4 py-4">
            <PaymentMethodEditor
              pm={pm}
              users={users}
              companies={companies}
              canAssign={isAdmin}
              onClose={props.onCloseEdit}
              onSaved={props.onSaved}
              onError={props.onError}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function PaymentMethodEditor({ pm, users, companies, canAssign, onClose, onSaved, onError }: {
  pm: PaymentMethod;
  users: User[];
  companies: Array<{ id: string; name: string }>;
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
    mutationFn: () => {
      const move = patchForCompanyMove(pm, form.defaultZohoEntity);
      return paymentMethodsApi.update(pm.id, {
        label: form.label,
        lastFour: form.lastFour || undefined,
        brand: form.brand || undefined,
        zohoAccountName: move.zohoAccountName === null ? null : (form.zohoAccountName || undefined),
        defaultZohoEntity: move.defaultZohoEntity,
        requiresReimbursement: form.requiresReimbursement,
        ...(canAssign
          ? {
              isCompanyWide: form.assignment === 'company',
              assignedUserId: form.assignment === 'assigned' && form.assignedUserId ? form.assignedUserId : null,
            }
          : {}),
      });
    },
    onSuccess: onSaved,
    onError: (err: any) => onError(err?.response?.data?.error?.message ?? 'Could not update payment method'),
  });

  function set(key: keyof typeof form, value: string | boolean) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const assignedMissing = canAssign && form.assignment === 'assigned' && !form.assignedUserId;

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Edit — {pm.label}</h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-charcoal/80">Label *</label>
          <input value={form.label} onChange={(e) => set('label', e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-charcoal/80">Last 4 digits</label>
          <input
            value={form.lastFour}
            onChange={(e) => set('lastFour', e.target.value.replace(/\D/g, '').slice(0, 4))}
            maxLength={4}
            className={inputCls}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-charcoal/80">Card brand</label>
          <select value={form.brand} onChange={(e) => set('brand', e.target.value)} className={inputCls}>
            <option value="">— Select brand —</option>
            {Object.entries(BRAND_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-charcoal/80">Zoho paid-through account</label>
          <input
            value={form.zohoAccountName}
            onChange={(e) => set('zohoAccountName', e.target.value)}
            placeholder="Zoho Books paid-through account id"
            className={inputCls}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-charcoal/80">Company</label>
          <select value={form.defaultZohoEntity} onChange={(e) => set('defaultZohoEntity', e.target.value)} className={inputCls}>
            <option value="">Unassigned</option>
            {companies.map((c) => (
              <option key={c.id} value={c.name}>{c.name}</option>
            ))}
          </select>
        </div>
        <div className="flex items-end pb-2">
          <label className="flex items-center gap-2 text-sm text-charcoal/80">
            <input
              type="checkbox"
              checked={form.requiresReimbursement}
              onChange={(e) => set('requiresReimbursement', e.target.checked)}
              className="rounded border-ink/15"
            />
            Personal card — needs reimbursement
          </label>
        </div>
      </div>

      {/* Assignment control — needs the admin-only users list */}
      {canAssign ? (
        <div className="rounded-lg border border-ink/10 bg-white p-3">
          <p className="mb-2 text-xs font-medium text-charcoal/80">Assignment</p>
          <div className="flex flex-wrap items-center gap-5">
            <label className="flex items-center gap-2 text-sm text-charcoal/80">
              <input
                type="radio"
                name={`assignment-${pm.id}`}
                checked={form.assignment === 'company'}
                onChange={() => set('assignment', 'company')}
                className="border-ink/15"
              />
              Company-wide (everyone sees it)
            </label>
            <label className="flex items-center gap-2 text-sm text-charcoal/80">
              <input
                type="radio"
                name={`assignment-${pm.id}`}
                checked={form.assignment === 'assigned'}
                onChange={() => set('assignment', 'assigned')}
                className="border-ink/15"
              />
              Assigned to
            </label>
            {form.assignment === 'assigned' && (
              <select
                value={form.assignedUserId}
                onChange={(e) => set('assignedUserId', e.target.value)}
                className="w-full rounded-lg border border-ink/15 px-3 py-3 text-sm focus:border-brand-500 focus:outline-none sm:w-56 lg:py-1.5"
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
        <p className="text-xs text-muted">
          Assignment: {pm.isCompanyWide ? 'company-wide.' : 'assigned to a specific user.'} Only admins can change card assignment.
        </p>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          onClick={() => saveMutation.mutate()}
          disabled={!form.label || assignedMissing || saveMutation.isPending}
          className="min-h-11 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-cream hover:bg-brand-700 disabled:opacity-60 lg:min-h-0"
        >
          {saveMutation.isPending ? 'Saving…' : 'Save changes'}
        </button>
        <button
          onClick={onClose}
          className="min-h-11 rounded-lg border border-ink/15 px-4 py-2 text-sm font-medium text-charcoal/80 hover:bg-ink/[0.03] lg:min-h-0"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
