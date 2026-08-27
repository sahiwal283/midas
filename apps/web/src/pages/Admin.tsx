import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import client from '../api/client';
import { MyAccountSection } from './settings/MyAccountSection';
import { PaymentMethodsSection } from './settings/PaymentMethodsSection';
import { BudgetsSection } from './settings/BudgetsSection';
import { flattenTree } from '../lib/categoryTree';
import { ChartOfAccountsSection } from './settings/ChartOfAccountsSection';
import { CategoriesSection } from './settings/CategoriesSection';
import { ClosedPeriodsSection } from './settings/ClosedPeriodsSection';
import { UsersSection } from './settings/UsersSection';
import { PageHeader } from '../components/PageHeader';
import type { ExpenseCategory } from '../types';

type Section = 'account' | 'companies' | 'users' | 'categories' | 'chart-of-accounts' | 'payment-methods' | 'budgets' | 'closed-periods' | 'connections' | 'audit';

type NavGroup = { label: string; items: { id: Section; label: string }[] };

const ACCOUNT_GROUP: NavGroup = { label: 'Account', items: [{ id: 'account', label: 'My Account' }] };
const EXPENSES_GROUP: NavGroup = {
  label: 'Expenses',
  items: [
    { id: 'categories', label: 'Categories' },
    { id: 'chart-of-accounts', label: 'Chart of Accounts' },
    { id: 'payment-methods', label: 'Payment Methods' },
    { id: 'budgets', label: 'Budgets' },
    { id: 'closed-periods', label: 'Closed Periods' },
  ],
};

/** Role-scoped settings nav: everyone gets My Account; accountants add the
 *  Expenses group; admins (and developers) see everything. */
function navGroupsForRole(role: string | undefined): NavGroup[] {
  if (role === 'admin' || role === 'developer') {
    return [
      ACCOUNT_GROUP,
      { label: 'Company', items: [{ id: 'companies', label: 'Companies' }] },
      { label: 'People', items: [{ id: 'users', label: 'Users' }] },
      EXPENSES_GROUP,
      { label: 'Integrations', items: [{ id: 'connections', label: 'Connections' }] },
      { label: 'Security', items: [{ id: 'audit', label: 'Audit Log' }] },
    ];
  }
  if (role === 'accountant') {
    return [
      ACCOUNT_GROUP,
      EXPENSES_GROUP,
    ];
  }
  return [ACCOUNT_GROUP];
}

function defaultSectionForRole(role: string | undefined): Section {
  if (role === 'admin' || role === 'developer') return 'users';
  if (role === 'accountant') return 'categories';
  return 'account';
}

const inputCls = 'w-full rounded-lg border border-ink/15 px-3 py-3 text-sm focus:border-brand-500 focus:outline-none lg:py-2';

function ErrorPanel({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  if (!message) return null;
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-danger/25 bg-danger/10 px-4 py-3 text-sm text-danger">
      <span>{message}</span>
      <button onClick={onDismiss} className="shrink-0 text-xs text-danger underline hover:text-danger">
        Dismiss
      </button>
    </div>
  );
}

export function Admin() {
  const { user } = useAuth();
  const [section, setSection] = useState<Section>(() => defaultSectionForRole(user?.role));

  const navGroups = navGroupsForRole(user?.role);
  const allowedSections = new Set(navGroups.flatMap((g) => g.items.map((i) => i.id)));
  const activeSection = allowedSections.has(section) ? section : defaultSectionForRole(user?.role);

  return (
    <div className="page">
      <PageHeader title="Settings" />

      <div className="flex flex-col gap-5 lg:flex-row lg:gap-8">
        {/* Grouped section nav: horizontal chip strip on phones, grouped column ≥lg */}
        <nav className="w-full shrink-0 lg:w-52">
          <div className="-mx-4 overflow-x-auto px-4 pb-1 lg:hidden">
            <div className="flex w-max gap-2">
              {navGroups.flatMap((group) => group.items).map((item) => (
                <button
                  key={item.id}
                  onClick={() => setSection(item.id)}
                  className={`min-h-11 shrink-0 whitespace-nowrap rounded-full border px-4 text-sm font-medium transition-colors ${
                    activeSection === item.id
                      ? 'border-brand-200 bg-brand-50 text-brand-700'
                      : 'border-ink/10 bg-white text-charcoal/70 hover:text-ink'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <div className="hidden space-y-5 rounded-xl border border-ink/10 bg-white p-4 lg:block">
            {navGroups.map((group) => (
              <div key={group.label}>
                <p className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-charcoal/40">
                  {group.label}
                </p>
                <div className="space-y-0.5">
                  {group.items.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => setSection(item.id)}
                      className={`block w-full rounded-lg px-2 py-1.5 text-left text-sm font-medium transition-colors ${
                        activeSection === item.id
                          ? 'bg-brand-50 text-brand-700'
                          : 'text-charcoal/70 hover:bg-ink/[0.03] hover:text-ink'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </nav>

        <div className="min-w-0 flex-1">
          {activeSection === 'account' && <MyAccountSection />}
          {activeSection === 'users' && <UsersSection />}
          {activeSection === 'companies' && <CompaniesTab />}
          {activeSection === 'categories' && <CategoriesSection />}
          {activeSection === 'chart-of-accounts' && <ChartOfAccountsSection />}
          {activeSection === 'payment-methods' && <PaymentMethodsSection />}
          {activeSection === 'budgets' && <BudgetsSection />}
          {activeSection === 'closed-periods' && <ClosedPeriodsSection />}
          {activeSection === 'connections' && <ConnectionsTab />}
          {activeSection === 'audit' && <AuditTab />}
        </div>
      </div>
    </div>
  );
}

// ── Companies ────────────────────────────────────────────────────────────────

function CompaniesTab() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const { data: companies = [], isLoading } = useQuery({
    queryKey: ['admin-companies'],
    queryFn: () => client.get('/admin/companies').then((r) => r.data.companies),
  });

  const createMutation = useMutation({
    mutationFn: () => client.post('/admin/companies', { name }),
    onSuccess: () => {
      setName('');
      setError('');
      qc.invalidateQueries({ queryKey: ['admin-companies'] });
      qc.invalidateQueries({ queryKey: ['companies'] });
    },
    onError: (err: any) => setError(err?.response?.data?.error?.message ?? 'Could not add company'),
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, ...body }: { id: string; zohoEnabled?: boolean; isActive?: boolean }) =>
      client.patch(`/admin/companies/${id}`, body),
    onSuccess: () => {
      setError('');
      qc.invalidateQueries({ queryKey: ['admin-companies'] });
      qc.invalidateQueries({ queryKey: ['companies'] });
    },
    onError: (err: any) => setError(err?.response?.data?.error?.message ?? 'Update failed'),
  });

  if (isLoading) return <div className="text-sm text-charcoal/40">Loading…</div>;

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Companies appear in the expense form's Company picker. Companies with Zoho off never sync to Zoho —
        their expenses always go to the accountant.
      </p>

      <ErrorPanel message={error} onDismiss={() => setError('')} />

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New company name"
          className="w-full rounded-lg border border-ink/15 px-3 py-3 text-sm focus:border-brand-500 focus:outline-none sm:w-64 lg:py-2"
        />
        <button
          onClick={() => createMutation.mutate()}
          disabled={!name.trim() || createMutation.isPending}
          className="min-h-11 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-cream hover:bg-brand-700 disabled:opacity-60 lg:min-h-0"
        >
          Add Company
        </button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-ink/10 bg-white">
        {/* Mobile cards */}
        <div className="divide-y divide-ink/5 md:hidden">
          {companies.map((c: any) => (
            <div key={c.id} className="space-y-3 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">{c.name}</span>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${c.zohoEnabled ? 'bg-success/15 text-success' : 'bg-brand-50 text-charcoal/70'}`}>
                  {c.zohoEnabled ? 'Syncs to Zoho' : 'No Zoho'}
                </span>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${c.isActive ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'}`}>
                  {c.isActive ? 'Active' : 'Inactive'}
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => patchMutation.mutate({ id: c.id, zohoEnabled: !c.zohoEnabled })}
                  disabled={patchMutation.isPending}
                  className="min-h-11 flex-1 rounded border border-ink/10 bg-cream px-2.5 text-xs font-medium text-charcoal/70 hover:bg-brand-50 disabled:opacity-40"
                >
                  {c.zohoEnabled ? 'Disable Zoho' : 'Enable Zoho'}
                </button>
                <button
                  onClick={() => patchMutation.mutate({ id: c.id, isActive: !c.isActive })}
                  disabled={patchMutation.isPending}
                  className={`min-h-11 flex-1 rounded border px-2.5 text-xs font-medium disabled:opacity-40 ${
                    c.isActive
                      ? 'border-danger/25 bg-danger/10 text-danger hover:bg-red-100'
                      : 'border-success/30 bg-success/10 text-success hover:bg-success/15'
                  }`}
                >
                  {c.isActive ? 'Deactivate' : 'Reactivate'}
                </button>
              </div>
            </div>
          ))}
        </div>
        <table className="hidden w-full text-sm md:table">
          <thead>
            <tr className="border-b text-left field-caption">
              <th className="px-5 py-3">Name</th>
              <th className="px-5 py-3">Zoho</th>
              <th className="px-5 py-3">Status</th>
              <th className="px-5 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink/5">
            {companies.map((c: any) => (
              <tr key={c.id} className="hover:bg-ink/[0.03]">
                <td className="px-5 py-3 font-medium text-ink">{c.name}</td>
                <td className="px-5 py-3">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${c.zohoEnabled ? 'bg-success/15 text-success' : 'bg-brand-50 text-charcoal/70'}`}>
                    {c.zohoEnabled ? 'Syncs to Zoho' : 'No Zoho'}
                  </span>
                </td>
                <td className="px-5 py-3">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${c.isActive ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'}`}>
                    {c.isActive ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => patchMutation.mutate({ id: c.id, zohoEnabled: !c.zohoEnabled })}
                      disabled={patchMutation.isPending}
                      className="rounded border border-ink/10 bg-cream px-2.5 py-1 text-xs font-medium text-charcoal/70 hover:bg-brand-50 disabled:opacity-40"
                    >
                      {c.zohoEnabled ? 'Disable Zoho' : 'Enable Zoho'}
                    </button>
                    <button
                      onClick={() => patchMutation.mutate({ id: c.id, isActive: !c.isActive })}
                      disabled={patchMutation.isPending}
                      className={`rounded border px-2.5 py-1 text-xs font-medium disabled:opacity-40 ${
                        c.isActive
                          ? 'border-danger/25 bg-danger/10 text-danger hover:bg-red-100'
                          : 'border-success/30 bg-success/10 text-success hover:bg-success/15'
                      }`}
                    >
                      {c.isActive ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Audit Log ────────────────────────────────────────────────────────────────

interface AuditEntry {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  before: unknown;
  after: unknown;
  metadata: unknown;
  createdAt: string;
  actorId: string | null;
  actorName: string | null;
}

const AUDIT_PAGE_SIZE = 50;

function AuditTab() {
  const [filters, setFilters] = useState({ entityType: '', action: '', from: '', to: '', search: '' });
  const [page, setPage] = useState(1);
  const [seenEntityTypes, setSeenEntityTypes] = useState<string[]>([]);

  const params: Record<string, string | number> = { page, pageSize: AUDIT_PAGE_SIZE };
  for (const [k, v] of Object.entries(filters)) {
    if (v.trim()) params[k] = v.trim();
  }

  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-audit', params],
    queryFn: () => client
      .get<{ entries: AuditEntry[]; total: number; page: number; pageSize: number }>('/admin/audit', { params })
      .then((r) => {
        setSeenEntityTypes((prev) => Array.from(new Set([...prev, ...r.data.entries.map((e) => e.entityType)])).sort());
        return r.data;
      }),
    placeholderData: keepPreviousData,
  });

  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));

  function setFilter(key: keyof typeof filters, value: string) {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Immutable, append-only record of every significant action. Newest first.
      </p>

      {/* Filter bar */}
      <div className="grid grid-cols-2 gap-3 rounded-xl border border-ink/10 bg-white p-4 sm:grid-cols-3 lg:grid-cols-5">
        <div>
          <label className="mb-1 block text-xs font-medium text-charcoal/70">Entity type</label>
          <input
            list="audit-entity-types"
            value={filters.entityType}
            onChange={(e) => setFilter('entityType', e.target.value)}
            placeholder="e.g. user"
            className={inputCls}
          />
          <datalist id="audit-entity-types">
            {seenEntityTypes.map((t) => <option key={t} value={t} />)}
          </datalist>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-charcoal/70">Action prefix</label>
          <input
            value={filters.action}
            onChange={(e) => setFilter('action', e.target.value)}
            placeholder="e.g. admin.user"
            className={inputCls}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-charcoal/70">From</label>
          <input type="date" value={filters.from} onChange={(e) => setFilter('from', e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-charcoal/70">To</label>
          <input type="date" value={filters.to} onChange={(e) => setFilter('to', e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-charcoal/70">Search</label>
          <input
            value={filters.search}
            onChange={(e) => setFilter('search', e.target.value)}
            placeholder="action or entity type"
            className={inputCls}
          />
        </div>
      </div>

      {/* Results */}
      <div className="overflow-x-auto rounded-xl border border-ink/10 bg-white">
        {isLoading ? (
          <div className="px-6 py-12 text-center text-sm text-charcoal/40">Loading…</div>
        ) : isError ? (
          <div className="px-6 py-12 text-center text-sm text-danger">Could not load the audit log.</div>
        ) : entries.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-charcoal/40">No audit entries match these filters.</div>
        ) : (
          <>
            {/* Mobile cards */}
            <div className="divide-y divide-ink/5 md:hidden">
              {entries.map((e) => (
                <div key={e.id} className="space-y-1 p-4">
                  <p className="text-sm font-medium text-ink">
                    {e.actorName ?? <span className="font-normal text-charcoal/40">system</span>}
                  </p>
                  <p className="break-all font-mono text-xs text-ink">{e.action}</p>
                  <p className="text-xs text-charcoal/70">
                    <span className="font-medium">{e.entityType}</span>
                    <span className="ml-1 font-mono text-charcoal/40" title={e.entityId}>
                      {e.entityId.length > 12 ? `${e.entityId.slice(0, 12)}…` : e.entityId}
                    </span>
                  </p>
                  <p className="text-xs text-muted">{new Date(e.createdAt).toLocaleString()}</p>
                  {(e.before || e.after || e.metadata) ? (
                    <details>
                      <summary className="cursor-pointer select-none py-1.5 text-xs text-brand-700 hover:underline">View details</summary>
                      <div className="mt-2 max-w-md space-y-2">
                        {e.before != null && <AuditJson label="Before" value={e.before} />}
                        {e.after != null && <AuditJson label="After" value={e.after} />}
                        {e.metadata != null && <AuditJson label="Metadata" value={e.metadata} />}
                      </div>
                    </details>
                  ) : null}
                </div>
              ))}
            </div>
            <table className="hidden w-full text-sm md:table">
            <thead>
              <tr className="border-b text-left field-caption">
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">Actor</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Entity</th>
                <th className="px-4 py-3">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {entries.map((e) => (
                <tr key={e.id} className="align-top hover:bg-ink/[0.03]">
                  <td className="whitespace-nowrap px-4 py-3 text-charcoal/70">{new Date(e.createdAt).toLocaleString()}</td>
                  <td className="px-4 py-3 text-charcoal/70">{e.actorName ?? <span className="text-charcoal/40">system</span>}</td>
                  <td className="px-4 py-3 font-mono text-xs text-ink">{e.action}</td>
                  <td className="px-4 py-3 text-charcoal/70">
                    <span className="font-medium">{e.entityType}</span>
                    <span className="ml-1 font-mono text-xs text-charcoal/40" title={e.entityId}>
                      {e.entityId.length > 12 ? `${e.entityId.slice(0, 12)}…` : e.entityId}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {(e.before || e.after || e.metadata) ? (
                      <details>
                        <summary className="cursor-pointer select-none text-xs text-brand-700 hover:underline">View</summary>
                        <div className="mt-2 max-w-md space-y-2">
                          {e.before != null && <AuditJson label="Before" value={e.before} />}
                          {e.after != null && <AuditJson label="After" value={e.after} />}
                          {e.metadata != null && <AuditJson label="Metadata" value={e.metadata} />}
                        </div>
                      </details>
                    ) : (
                      <span className="text-xs text-charcoal/25">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            </table>
          </>
        )}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-sm text-charcoal/70">
        <span>
          {total} entr{total === 1 ? 'y' : 'ies'}{total > 0 ? ` · page ${page} of ${lastPage}` : ''}
        </span>
        <div className="flex gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="min-h-11 rounded-lg border border-ink/15 px-3 py-1.5 text-sm font-medium text-charcoal/80 hover:bg-ink/[0.03] disabled:opacity-40 lg:min-h-0"
          >
            ← Prev
          </button>
          <button
            onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
            disabled={page >= lastPage}
            className="min-h-11 rounded-lg border border-ink/15 px-3 py-1.5 text-sm font-medium text-charcoal/80 hover:bg-ink/[0.03] disabled:opacity-40 lg:min-h-0"
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  );
}

function AuditJson({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-charcoal/40">{label}</p>
      <pre className="mt-0.5 max-h-48 overflow-auto rounded bg-cream p-2 text-[11px] leading-relaxed text-charcoal/80">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

// ── Connections ──────────────────────────────────────────────────────────────

const EXT_SCOPES = [
  'expenses:create',
  'expenses:read',
  'expenses:update',
  'expenses:delete',
  'receipts:create',
  'expenses:import',
  'ocr:process',
] as const;

const TRADE_SHOW_DEFAULT_SCOPES = [...EXT_SCOPES];

function ConnectionsTab() {
  const qc = useQueryClient();
  const [appName, setAppName] = useState('');
  const [scopes, setScopes] = useState<string[]>([...TRADE_SHOW_DEFAULT_SCOPES]);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [vocabFor, setVocabFor] = useState<string | null>(null);
  const { data: connections = [] } = useQuery({
    queryKey: ['admin-connections'],
    queryFn: () => client.get('/admin/connections').then((r) => r.data.connections),
  });

  const createMutation = useMutation({
    mutationFn: () => client.post('/admin/connections', { appName, permissions: scopes }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['admin-connections'] });
      setNewKey(res.data.apiKey);
      setAppName('');
      setError('');
    },
    onError: (err: any) => setError(err?.response?.data?.error?.message ?? 'Could not generate key'),
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, ...body }: { id: string; isActive?: boolean; permissions?: string[] }) =>
      client.patch(`/admin/connections/${id}`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-connections'] }); setError(''); },
    onError: (err: any) => setError(err?.response?.data?.error?.message ?? 'Update failed'),
  });

  function toggleScope(scope: string) {
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        API keys allow other internal apps to call <code>/api/v1/ext/</code>. Empty scopes deny all Ext routes.
        Use app name <code>trade_show</code> with all scopes checked for the Trade Show BFF.
      </p>
      <ErrorPanel message={error} onDismiss={() => setError('')} />
      <div className="flex flex-wrap items-start gap-3">
        <input
          value={appName}
          onChange={(e) => setAppName(e.target.value)}
          placeholder="App name (e.g. trade_show)"
          className="w-64 rounded-lg border border-ink/15 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
        />
        <button
          onClick={() => createMutation.mutate()}
          disabled={!appName.trim() || scopes.length === 0 || createMutation.isPending}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-cream hover:bg-brand-700 disabled:opacity-60"
        >
          Generate Key
        </button>
      </div>
      <div className="flex flex-wrap gap-3 rounded-lg border border-ink/10 bg-white p-3">
        {EXT_SCOPES.map((scope) => (
          <label key={scope} className="flex items-center gap-1.5 text-xs text-charcoal/80">
            <input
              type="checkbox"
              checked={scopes.includes(scope)}
              onChange={() => toggleScope(scope)}
              className="rounded border-ink/15"
            />
            {scope}
          </label>
        ))}
      </div>

      {newKey && (
        <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-4">
          <p className="mb-1 text-sm font-semibold text-yellow-800">API Key (shown once — copy it now):</p>
          <code className="break-all text-xs text-yellow-900">{newKey}</code>
        </div>
      )}

      <div className="rounded-xl border border-ink/10 bg-white">
        {connections.map((c: { id: string; appName: string; permissions?: string[]; isActive: boolean }) => (
          <div key={c.id} className="flex items-center justify-between gap-4 border-b border-ink/5 px-5 py-3 last:border-0">
            <div className="min-w-0">
              <p className="font-medium text-ink">{c.appName}</p>
              <p className="break-all text-xs text-charcoal/40">
                {c.permissions?.length ? c.permissions.join(', ') : 'no scopes (all Ext calls denied)'}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className={`rounded-full px-2.5 py-0.5 text-xs ${c.isActive ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'}`}>
                {c.isActive ? 'Active' : 'Revoked'}
              </span>
              <button
                type="button"
                onClick={() => setVocabFor(vocabFor === c.id ? null : c.id)}
                className="rounded border border-ink/10 px-2 py-1 text-xs text-charcoal/70 hover:bg-ink/[0.03]"
              >
                Categories
              </button>
              <button
                type="button"
                disabled={patchMutation.isPending}
                onClick={() => patchMutation.mutate({ id: c.id, isActive: !c.isActive })}
                className="rounded border border-ink/10 px-2 py-1 text-xs text-charcoal/70 hover:bg-ink/[0.03] disabled:opacity-60"
              >
                {c.isActive ? 'Revoke' : 'Activate'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {vocabFor && (
        <ConnectionCategories
          connectionId={vocabFor}
          appName={connections.find((c: { id: string; appName: string }) => c.id === vocabFor)?.appName ?? ''}
          onClose={() => setVocabFor(null)}
        />
      )}
    </div>
  );
}

/**
 * Which categories a consuming app sees from GET /ext/categories.
 * Selecting none means unrestricted — the app sees every active category.
 */
function ConnectionCategories({ connectionId, appName, onClose }: {
  connectionId: string;
  appName: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string> | null>(null);

  const { data: categories = [] } = useQuery<ExpenseCategory[]>({
    queryKey: ['admin-categories'],
    queryFn: () => client.get('/admin/categories').then((r) => r.data.categories),
  });
  const { data: vocab } = useQuery<{ categoryIds: string[]; unrestricted: boolean }>({
    queryKey: ['connection-categories', connectionId],
    queryFn: () => client.get(`/admin/connections/${connectionId}/categories`).then((r) => r.data),
  });

  useEffect(() => {
    if (vocab && selected === null) setSelected(new Set(vocab.categoryIds));
  }, [vocab, selected]);

  const saveMutation = useMutation({
    mutationFn: () => client.put(`/admin/connections/${connectionId}/categories`, {
      categoryIds: [...(selected ?? [])],
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connection-categories', connectionId] });
      setError('');
      onClose();
    },
    onError: (err: any) => setError(err?.response?.data?.error?.message ?? 'Could not save'),
  });

  const ordered = useMemo(() => flattenTree(categories), [categories]);
  const chosen = selected ?? new Set<string>();

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <div className="rounded-xl border border-ink/10 bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="font-medium text-ink">Categories visible to {appName}</h3>
          <p className="mt-0.5 text-xs text-muted">
            {chosen.size === 0
              ? 'None selected — this app sees every active category.'
              : `${chosen.size} selected — this app sees only these.`}
          </p>
        </div>
        <button onClick={onClose} className="text-xs text-charcoal/40 underline hover:text-charcoal/70">Close</button>
      </div>

      <ErrorPanel message={error} onDismiss={() => setError('')} />

      <div className="max-h-80 overflow-y-auto rounded-lg border border-ink/5">
        {ordered.map(({ cat, depth }) => (
          <label
            key={cat.id}
            className="flex cursor-pointer items-center gap-2 border-b border-ink/5 px-3 py-1.5 text-sm last:border-0 hover:bg-ink/[0.03]"
            style={{ paddingLeft: 12 + depth * 18 }}
          >
            <input
              type="checkbox"
              checked={chosen.has(cat.id)}
              onChange={() => toggle(cat.id)}
              className="h-3.5 w-3.5"
            />
            <span className={cat.isActive ? 'text-ink' : 'text-charcoal/40 line-through'}>{cat.name}</span>
          </label>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-cream hover:bg-brand-700 disabled:opacity-60"
        >
          Save
        </button>
        <button
          onClick={() => setSelected(new Set())}
          className="text-xs text-muted underline hover:text-ink"
        >
          Clear all (unrestricted)
        </button>
      </div>
    </div>
  );
}
