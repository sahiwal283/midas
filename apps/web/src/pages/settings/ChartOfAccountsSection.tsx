import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, ChevronDown, AlertCircle } from 'lucide-react';
import client from '../../api/client';
import { companyApi } from '../../api/companies';
import { expenseApi } from '../../api/expenses';
import { SearchableSelect, type SearchableOption } from '../../components/SearchableSelect';
import { useCollapsibleTree } from '../../lib/useCollapsibleTree';
import { pathFromRoot } from '../../lib/categoryTree';
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

/**
 * Links each Midas expense category to an account from one company's live Zoho
 * Books chart of accounts. Account ids differ per sister company, so mappings
 * are per (category, company); unmapped categories inherit from the nearest
 * mapped ancestor when an expense is pushed.
 */
export function ChartOfAccountsSection() {
  const qc = useQueryClient();
  const [company, setCompany] = useState('');
  const [error, setError] = useState('');

  const { data: companies = [] } = useQuery({
    queryKey: ['companies'],
    queryFn: () => companyApi.list(),
  });
  // isActive is optional on the shared Company type — treat "absent" as active.
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
    onError: (err: any) => setError(err?.response?.data?.error?.message ?? 'Could not save the mapping'),
  });
  const clearMutation = useMutation({
    mutationFn: (categoryId: string) =>
      client.delete('/admin/category-zoho-accounts', { params: { categoryId, companyName: company } }),
    onSuccess: () => { invalidate(); setError(''); },
    onError: (err: any) => setError(err?.response?.data?.error?.message ?? 'Could not clear the mapping'),
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
    onError: (err: any) => setError(err?.response?.data?.error?.message ?? 'Could not import categories from Zoho'),
  });

  const { rows, toggle, expandAll, collapseAll } = useCollapsibleTree(categories);
  const accountName = (id: string) => accounts.find((a) => a.accountId === id)?.accountName ?? id;

  /** Account ids already claimed by some OTHER category for this company. */
  const claimedElsewhere = useMemo(() => {
    const byAccount = new Map<string, string>();
    for (const m of mappings) byAccount.set(m.zohoAccountId, m.categoryId);
    return byAccount;
  }, [mappings]);

  /**
   * One account maps to one category per company, so accounts already used
   * elsewhere are hidden. The row's own mapping always stays selectable — as
   * does a saved id Zoho no longer returns, so it never silently disappears.
   */
  const optionsFor = (categoryId: string, mapped: string): SearchableOption[] => {
    const opts: SearchableOption[] = accounts
      .filter((a) => {
        const owner = claimedElsewhere.get(a.accountId);
        return !owner || owner === categoryId;
      })
      .map((a) => ({
        value: a.accountId,
        label: a.accountName,
        hint: a.accountCode ?? undefined,
      }));
    if (mapped && !opts.some((o) => o.value === mapped)) {
      opts.unshift({ value: mapped, label: mapped, hint: 'not in current Zoho list' });
    }
    return opts;
  };

  const claimedCount = claimedElsewhere.size;

  /** Nearest mapped ancestor (excluding the category itself) — what it inherits. */
  const inheritedFrom = (categoryId: string): { name: string; accountId: string } | null => {
    const chain = pathFromRoot(categories, categoryId).slice(0, -1).reverse();
    for (const ancestorId of chain) {
      const hit = mappedByCategory.get(ancestorId);
      if (hit) {
        return { name: categories.find((c) => c.id === ancestorId)?.name ?? 'parent', accountId: hit };
      }
    }
    return null;
  };

  const mappedCount = mappings.length;

  if (zohoCompanies.length === 0) {
    return (
      <p className="text-sm text-gray-500">
        No Zoho-enabled companies. Turn on Zoho for a company under Settings → Companies first.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">
        Link each Midas category to an account from this company's Zoho chart of accounts. Zoho account
        ids differ per company, so mappings are saved per company. A category left unmapped uses the
        nearest mapped parent above it.
      </p>

      {error && (
        <div className="flex items-start justify-between gap-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>{error}</span>
          <button onClick={() => setError('')} className="shrink-0 text-xs text-red-500 underline hover:text-red-700">
            Dismiss
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm font-medium text-gray-700" htmlFor="coa-company">Company</label>
        <select
          id="coa-company"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
        >
          {zohoCompanies.map((c) => (
            <option key={c.id} value={c.name}>{c.name}</option>
          ))}
        </select>
        <span className="text-xs text-gray-400">
          {accountsLoading
            ? 'Loading Zoho accounts…'
            : `${accounts.length} Zoho accounts · ${mappedCount} mapped · ${Math.max(0, accounts.length - claimedCount)} still available`}
        </span>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <button
            onClick={() => { setSyncResult(''); syncMutation.mutate(); }}
            disabled={syncMutation.isPending}
            className="rounded-lg border border-brand-300 px-3 py-1.5 font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-60"
          >
            {syncMutation.isPending ? 'Importing…' : 'Import categories from Zoho'}
          </button>
          <button onClick={expandAll} className="text-brand-600 underline hover:text-brand-700">Expand all</button>
          <button onClick={collapseAll} className="text-brand-600 underline hover:text-brand-700">Collapse all</button>
        </div>
      </div>

      {syncResult && (
        <div className="rounded-lg border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-800">
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

      <div className="rounded-xl border border-gray-200 bg-white">
        {rows.map(({ cat, depth, hasChildren, collapsed, descendantCount }) => {
          const mapped = mappedByCategory.get(cat.id) ?? '';
          const inherited = mapped ? null : inheritedFrom(cat.id);
          return (
            <div key={cat.id} className="flex flex-wrap items-center gap-3 border-b border-gray-100 px-5 py-2.5 last:border-0">
              <div className="flex min-w-[16rem] flex-1 items-center gap-1.5" style={{ paddingLeft: depth * 20 }}>
                {hasChildren ? (
                  <button
                    onClick={() => toggle(cat.id)}
                    className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                    aria-label={collapsed ? `Expand ${cat.name}` : `Collapse ${cat.name}`}
                    aria-expanded={!collapsed}
                  >
                    {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>
                ) : (
                  <span className="inline-block w-5" />
                )}
                <span className={`text-sm ${cat.isActive ? 'text-gray-900' : 'text-gray-400 line-through'}`}>
                  {cat.name}
                  {hasChildren && collapsed && (
                    <span className="ml-2 text-xs text-gray-400">{descendantCount}</span>
                  )}
                </span>
              </div>

              <div className="w-72">
                <SearchableSelect
                  options={optionsFor(cat.id, mapped)}
                  value={mapped}
                  disabled={accountsFailed || accountsLoading}
                  placeholder={inherited ? `Inherited from ${inherited.name}` : 'Search accounts…'}
                  onChange={(accountId) => {
                    if (accountId) setMutation.mutate({ categoryId: cat.id, zohoAccountId: accountId });
                    else if (mapped) clearMutation.mutate(cat.id);
                  }}
                />
              </div>

              <div className="flex w-40 items-center justify-end gap-2">
                {mapped ? (
                  <>
                    <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">Mapped</span>
                    <button
                      onClick={() => clearMutation.mutate(cat.id)}
                      className="text-xs text-gray-400 underline hover:text-gray-600"
                    >
                      Clear
                    </button>
                  </>
                ) : inherited ? (
                  <span
                    className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-600"
                    title={`Uses ${accountName(inherited.accountId)} from ${inherited.name}`}
                  >
                    Inherited
                  </span>
                ) : (
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">Unmapped</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-gray-400">
        A per-expense account chosen during accountant review always wins over these defaults.
      </p>
    </div>
  );
}
