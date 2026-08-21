import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Search, X } from 'lucide-react';
import client from '../../api/client';
import { companyApi } from '../../api/companies';
import { expenseApi } from '../../api/expenses';
import { SearchableSelect, type SearchableOption } from '../../components/SearchableSelect';
import { pathFromRoot } from '../../lib/categoryTree';
import { filterCoaAccounts, groupCoaByAccount, staleCoaMappings } from '@midas/shared';
import type { ExpenseCategory } from '../../types';

interface Mapping {
  categoryId: string;
  companyName: string;
  zohoAccountId: string;
}

interface ZohoAccount {
  accountId: string;
  accountName: string;
  accountCode: string | null;
  accountType: string;
}

const searchCls = 'w-full rounded-lg border border-ink/15 bg-white py-2.5 pl-9 pr-3 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 lg:py-2';

/**
 * Zoho accounts for one company, each with the Midas categories that post to it.
 * Several Midas categories may share one Zoho account (e.g. booth fees → Booth Expense).
 */
export function ChartOfAccountsSection() {
  const qc = useQueryClient();
  const [company, setCompany] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');

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

  const { data: categories = [] } = useQuery<ExpenseCategory[]>({
    queryKey: ['admin-categories'],
    queryFn: () => client.get('/admin/categories').then((r) => r.data.categories),
  });
  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  const {
    data: accountData,
    isFetching: accountsLoading,
    isError: accountsFailed,
  } = useQuery({
    queryKey: ['zoho-expense-accounts', company],
    queryFn: () => expenseApi.zohoExpenseAccounts(company),
    enabled: !!company,
    staleTime: 60_000,
    retry: 1,
  });
  const accounts: ZohoAccount[] = accountData?.accounts ?? [];

  const { data: mappings = [] } = useQuery<Mapping[]>({
    queryKey: ['coa-mappings', company],
    queryFn: () => client.get('/admin/category-zoho-accounts', { params: { companyName: company } })
      .then((r) => r.data.mappings),
    enabled: !!company,
  });
  const mappedByCategory = useMemo(
    () => new Map(mappings.map((m) => [m.categoryId, m.zohoAccountId])),
    [mappings],
  );

  const invalidate = () => qc.invalidateQueries({ queryKey: ['coa-mappings', company] });
  const setMutation = useMutation({
    mutationFn: (v: { categoryId: string; zohoAccountId: string }) =>
      client.put('/admin/category-zoho-accounts', { ...v, companyName: company }),
    onSuccess: () => { invalidate(); setError(''); },
    onError: (err: unknown) => setError(axiosMessage(err, 'Could not save the mapping')),
  });
  const clearMutation = useMutation({
    mutationFn: (categoryId: string) =>
      client.delete('/admin/category-zoho-accounts', { params: { categoryId, companyName: company } }),
    onSuccess: () => { invalidate(); setError(''); },
    onError: (err: unknown) => setError(axiosMessage(err, 'Could not clear the mapping')),
  });

  const [syncResult, setSyncResult] = useState('');
  const syncMutation = useMutation({
    mutationFn: () => client.post<{ summary: {
      company: string; brand: string | null; accounts: number; created: string[]; mapped: number; error?: string;
    }[] }>('/admin/categories/sync-zoho').then((r) => r.data),
    onSuccess: ({ summary }) => {
      setError('');
      const created = summary.flatMap((s) => s.created);
      const mapped = summary.reduce((n, s) => n + s.mapped, 0);
      const failures = summary.filter((s) => s.error).map((s) => `${s.company} (${s.error})`);
      setSyncResult(
        `${created.length ? `Created: ${created.join(', ')}. ` : 'No new categories. '}`
        + `${mapped} mapping${mapped === 1 ? '' : 's'} added.`
        + (failures.length ? ` Failed: ${failures.join('; ')}.` : ''),
      );
      void qc.invalidateQueries({ queryKey: ['admin-categories'] });
      void qc.invalidateQueries({ queryKey: ['expense-categories'] });
      void qc.invalidateQueries({ queryKey: ['coa-mappings'] });
    },
    onError: (err: unknown) => setError(axiosMessage(err, 'Could not import categories from Zoho')),
  });

  const accountRows = useMemo(
    () => groupCoaByAccount(
      accounts.map((a) => ({
        accountId: a.accountId,
        accountName: a.accountName,
        accountCode: a.accountCode,
      })),
      mappings,
    ),
    [accounts, mappings],
  );

  const searchableRows = useMemo(() => accountRows.map((row) => ({
    ...row,
    categoryNames: row.categoryIds.map((id) => byId.get(id)?.name ?? id),
  })), [accountRows, byId]);

  const visibleAccounts = useMemo(
    () => filterCoaAccounts(searchableRows, search),
    [searchableRows, search],
  );

  const staleMappings = useMemo(
    () => (accountsFailed ? [] : staleCoaMappings(accounts, mappings)),
    [accountsFailed, accounts, mappings],
  );

  const inheritedFrom = (categoryId: string): { name: string; accountId: string } | null => {
    const chain = pathFromRoot(categories, categoryId).slice(0, -1).reverse();
    for (const ancestorId of chain) {
      const hit = mappedByCategory.get(ancestorId);
      if (hit) {
        return { name: byId.get(ancestorId)?.name ?? 'parent', accountId: hit };
      }
    }
    return null;
  };

  const unmapped = useMemo(
    () => categories.filter((c) => !mappedByCategory.has(c.id)),
    [categories, mappedByCategory],
  );
  const q = search.trim().toLowerCase();
  const unmappedVisible = useMemo(
    () => unmapped.filter((c) => {
      if (!q) return true;
      return `${c.name} ${c.description ?? ''}`.toLowerCase().includes(q);
    }),
    [unmapped, q],
  );
  const staleVisible = useMemo(() => {
    if (!q) return staleMappings;
    return staleMappings.filter((m) => {
      const name = (byId.get(m.categoryId)?.name ?? '').toLowerCase();
      return name.includes(q) || m.zohoAccountId.toLowerCase().includes(q);
    });
  }, [staleMappings, q, byId]);

  const addOptions = (excludeIds: Set<string>): SearchableOption[] => (
    unmapped
      .filter((c) => !excludeIds.has(c.id))
      .map((c) => {
        const path = pathFromRoot(categories, c.id).map((id) => byId.get(id)?.name ?? id);
        return {
          value: c.id,
          label: c.name,
          hint: path.length > 1 ? path.slice(0, -1).join(' › ') : undefined,
        };
      })
  );

  const mappedCount = mappings.length;

  if (zohoCompanies.length === 0) {
    return (
      <p className="text-sm text-muted">
        No Zoho-enabled companies. Turn on Zoho for a company under Settings → Companies first.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Attach Midas categories to this company's Zoho accounts. Several categories can share one
        account — they stay separate in Midas and post together in Books. Unmapped categories inherit
        from a mapped parent at push time.
      </p>

      {error && (
        <div className="flex items-start justify-between gap-4 rounded-lg border border-danger/25 bg-danger/10 px-4 py-3 text-sm text-danger">
          <span>{error}</span>
          <button onClick={() => setError('')} className="shrink-0 text-xs text-danger underline hover:text-danger">
            Dismiss
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm font-medium text-charcoal/80" htmlFor="coa-company">Company</label>
        <select
          id="coa-company"
          value={company}
          onChange={(e) => { setCompany(e.target.value); setSearch(''); }}
          className="rounded-lg border border-ink/15 px-3 py-3 text-sm focus:border-brand-500 focus:outline-none lg:py-2"
        >
          {zohoCompanies.map((c) => (
            <option key={c.id} value={c.name}>{c.name}</option>
          ))}
        </select>
        <span className="text-xs text-charcoal/40">
          {accountsLoading
            ? 'Loading Zoho accounts…'
            : `${accounts.length} Zoho accounts · ${mappedCount} categor${mappedCount === 1 ? 'y' : 'ies'} mapped · ${unmapped.length} unmapped`}
        </span>
        <div className="ml-auto">
          <button
            onClick={() => { setSyncResult(''); syncMutation.mutate(); }}
            disabled={syncMutation.isPending}
            className="min-h-11 rounded-lg border border-brand-300 px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-60 lg:min-h-0"
          >
            {syncMutation.isPending ? 'Importing…' : 'Import categories from Zoho'}
          </button>
        </div>
      </div>

      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-charcoal/40" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search accounts or categories…"
          aria-label="Search chart of accounts"
          className={searchCls}
        />
      </div>

      {syncResult && (
        <div className="rounded-lg border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">
          {syncResult}
        </div>
      )}

      {accountsFailed && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Could not reach Zoho to load this company's chart of accounts. Saved mappings are shown
            below but cannot be changed until Zoho is reachable.
          </span>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-ink/10 bg-white">
        {visibleAccounts.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted">
            {search.trim() ? `No accounts match “${search.trim()}”.` : 'No Zoho accounts loaded.'}
          </p>
        ) : visibleAccounts.map((row) => {
          return (
            <div key={row.accountId} className="border-b border-ink/5 px-5 py-4 last:border-0">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-ink">{row.accountName}</p>
                  <p className="text-xs text-charcoal/40">
                    {row.accountCode ?? 'No account code'}
                  </p>
                </div>
                <div className="w-full sm:w-72">
                  <SearchableSelect
                    key={row.categoryIds.join(',')}
                    options={addOptions(new Set(row.categoryIds))}
                    value=""
                    disabled={accountsFailed || accountsLoading || unmapped.length === 0}
                    placeholder={unmapped.length === 0 ? 'All categories mapped' : 'Add a Midas category…'}
                    onChange={(categoryId) => {
                      if (categoryId) setMutation.mutate({ categoryId, zohoAccountId: row.accountId });
                    }}
                  />
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {row.categoryIds.length === 0 ? (
                  <span className="text-xs text-charcoal/40">No Midas categories attached</span>
                ) : row.categoryIds.map((id) => {
                  const cat = byId.get(id);
                  return (
                    <span
                      key={id}
                      className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-800"
                    >
                      {cat?.name ?? id}
                      <button
                        type="button"
                        onClick={() => clearMutation.mutate(id)}
                        disabled={accountsFailed}
                        className="rounded-full p-0.5 text-brand-600 hover:bg-brand-100 hover:text-danger disabled:opacity-40"
                        aria-label={`Remove ${cat?.name ?? id}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {staleVisible.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
          <h2 className="text-sm font-semibold text-amber-950">Removed from this company&apos;s Zoho chart</h2>
          <p className="mt-0.5 text-xs text-amber-900/70">
            These Midas categories still point at Zoho accounts that are gone from {company}.
            Clear them here, then attach the category to a current account above if it still needs one.
          </p>
          <ul className="mt-3 divide-y divide-amber-200/80">
            {staleVisible.map((m) => {
              const cat = byId.get(m.categoryId);
              return (
                <li key={`${m.categoryId}-${m.zohoAccountId}`} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm text-ink">{cat?.name ?? m.categoryId}</p>
                    <p className="truncate font-mono text-[11px] text-charcoal/40">{m.zohoAccountId}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => clearMutation.mutate(m.categoryId)}
                    className="shrink-0 rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100"
                  >
                    Clear mapping
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {unmappedVisible.length > 0 && (
        <div className="rounded-xl border border-ink/10 bg-white p-5">
          <h2 className="text-sm font-semibold text-charcoal/80">Unmapped Midas categories</h2>
          <p className="mt-0.5 text-xs text-charcoal/40">
            Add them to an account above. A mapped parent covers children at push time until you attach them explicitly.
          </p>
          <ul className="mt-3 divide-y divide-ink/5">
            {unmappedVisible.map((c) => {
              const inherited = inheritedFrom(c.id);
              return (
                <li key={c.id} className="flex items-center justify-between gap-3 py-2">
                  <span className={`text-sm ${c.isActive ? 'text-ink' : 'text-charcoal/40 line-through'}`}>{c.name}</span>
                  {inherited ? (
                    <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-600">
                      inherits from {inherited.name}
                    </span>
                  ) : (
                    <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs text-muted">Unmapped</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <p className="text-xs text-charcoal/40">
        A per-expense account chosen during accountant review always wins over these defaults.
        Import from Zoho creates a Midas category per Zoho account — skip it while trimming the list.
      </p>
    </div>
  );
}

function axiosMessage(err: unknown, fallback: string): string {
  const data = err && typeof err === 'object' && 'response' in err
    ? (err as { response?: { data?: { error?: { message?: string } } } }).response?.data
    : undefined;
  return data?.error?.message ?? fallback;
}
