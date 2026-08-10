import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Plus, AlertCircle, ChevronLeft, ChevronRight, Search, Trash2 } from 'lucide-react';
import { expenseApi } from '../api/expenses';
import { StatusBadge, ReimbursementBadge } from '../components/StatusBadge';
import { ReceiptDetailsButton } from '../components/ReceiptDetailsButton';
import { ExpenseQuickViewModal } from '../components/ExpenseQuickViewModal';
import { useAuth } from '../contexts/AuthContext';
import type { Expense } from '../types';

const PAGE_SIZE = 10;

type StatusTab = 'all' | 'needs_reply' | 'under_review' | 'approved' | 'rejected' | 'draft';

type ReimbFilter = '' | 'pending' | 'approved' | 'paid';

const REIMB_CHIPS: Array<{ id: ReimbFilter; label: string }> = [
  { id: '', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'paid', label: 'Paid' },
];

const STATUS_TABS: Array<{ id: StatusTab; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'needs_reply', label: 'Needs reply' },
  { id: 'under_review', label: 'Under review' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'draft', label: 'Drafts' },
];

const NEXT_ACTION: Record<string, { text: string; urgent: boolean }> = {
  draft: { text: 'Submit for approval', urgent: false },
  pending: { text: 'Pending approval', urgent: false },
  in_review: { text: 'Pending approval', urgent: false },
  awaiting_info: { text: 'Needs further review — reply', urgent: true },
  approved: { text: 'Approved', urgent: false },
  zoho_sync_failed: { text: 'Approved', urgent: false },
  rejected: { text: 'Rejected — see messages', urgent: false },
};

function matchesStatusTab(expense: Expense, tab: StatusTab): boolean {
  switch (tab) {
    case 'all':
      return true;
    case 'needs_reply':
      return expense.status === 'awaiting_info';
    case 'under_review':
      return expense.status === 'pending' || expense.status === 'in_review';
    case 'approved':
      return expense.status === 'approved' || expense.status === 'zoho_sync_failed';
    case 'rejected':
      return expense.status === 'rejected';
    case 'draft':
      return expense.status === 'draft';
    default: {
      const _exhaustive: never = tab;
      return _exhaustive;
    }
  }
}

function monthKey(date: string): string {
  // expense.date is YYYY-MM-DD
  return date.slice(0, 7);
}

function formatMonthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: 'short', year: 'numeric' });
}

function NextActionCell({ expense }: { expense: Expense }) {
  const action = NEXT_ACTION[expense.status];
  if (!action) return <span className="text-gray-400">—</span>;

  if (action.urgent) {
    return (
      <Link to={`/expenses/${expense.id}`} className="flex items-center gap-1 text-amber-700 font-medium hover:underline">
        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
        {action.text}
      </Link>
    );
  }
  return <span className="text-gray-500">{action.text}</span>;
}

export function ExpenseList() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { data: expenses = [], isLoading } = useQuery({
    queryKey: ['expenses'],
    queryFn: () => expenseApi.list(),
  });

  const [tab, setTab] = useState<StatusTab>('all');
  const [query, setQuery] = useState('');
  const [month, setMonth] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [sourceApp, setSourceApp] = useState('');
  const [reimbFilter, setReimbFilter] = useState<ReimbFilter>('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [quickViewId, setQuickViewId] = useState<string | null>(null);
  const [forceZoho, setForceZoho] = useState(false);
  const isAdmin = user?.role === 'admin';
  const canBulkDelete = user?.role === 'admin' || user?.role === 'accountant' || user?.role === 'user';

  const monthOptions = useMemo(() => {
    const keys = new Set<string>();
    for (const e of expenses) {
      if (e.date) keys.add(monthKey(e.date));
    }
    return [...keys].sort((a, b) => b.localeCompare(a));
  }, [expenses]);

  const categoryOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of expenses) {
      if (e.category?.id) map.set(e.category.id, e.category.name);
    }
    return [...map.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [expenses]);

  const tabCounts = useMemo(() => {
    const counts: Record<StatusTab, number> = {
      all: expenses.length,
      needs_reply: 0,
      under_review: 0,
      approved: 0,
      rejected: 0,
      draft: 0,
    };
    for (const e of expenses) {
      for (const t of STATUS_TABS) {
        if (t.id !== 'all' && matchesStatusTab(e, t.id)) counts[t.id] += 1;
      }
    }
    return counts;
  }, [expenses]);

  const sourceOptions = useMemo(() => {
    const keys = new Set<string>();
    for (const e of expenses) {
      if (e.sourceApp) keys.add(e.sourceApp);
    }
    return [...keys].sort();
  }, [expenses]);

  const hasReimbursements = useMemo(
    () => expenses.some((e) => e.reimbursementStatus !== 'not_requested'),
    [expenses],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return expenses.filter((e) => {
      if (!matchesStatusTab(e, tab)) return false;
      if (month && monthKey(e.date) !== month) return false;
      if (categoryId && e.categoryId !== categoryId) return false;
      if (sourceApp && e.sourceApp !== sourceApp) return false;
      if (reimbFilter && e.reimbursementStatus !== reimbFilter) return false;
      if (q) {
        const hay = `${e.merchant} ${e.description ?? ''} ${e.category?.name ?? ''} ${e.sourceLabel ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [expenses, tab, month, categoryId, sourceApp, reimbFilter, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pageRows = filtered.slice(pageStart, pageStart + PAGE_SIZE);
  const pageIds = pageRows.map((e) => e.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const selectedHasZoho = [...selected].some((id) => expenses.find((e) => e.id === id)?.zohoExpenseId);

  useEffect(() => {
    setPage(1);
  }, [tab, month, categoryId, sourceApp, reimbFilter, query]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    setSelected(new Set());
  }, [tab, month, categoryId, sourceApp, reimbFilter, query]);

  const bulkDeleteMutation = useMutation({
    mutationFn: () => expenseApi.bulkDelete([...selected], forceZoho && isAdmin),
    onSuccess: (result) => {
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: ['expenses'] });
      if (result.failed.length > 0) {
        alert(
          `Deleted ${result.deleted.length}. Failed ${result.failed.length}`
          + (result.failed.some((f) => f.message.includes('Zoho'))
            ? ' — enable “Force Zoho-linked” (admin) for Zoho-synced rows.'
            : '.'),
        );
      }
    },
  });

  const actionNeeded = tabCounts.needs_reply;
  const totalSpent = useMemo(
    () => filtered.reduce((sum, e) => sum + Number(e.amount || 0), 0),
    [filtered],
  );

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function togglePage() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allPageSelected) {
        for (const id of pageIds) next.delete(id);
      } else {
        for (const id of pageIds) next.add(id);
      }
      return next;
    });
  }

  function selectAllFiltered() {
    setSelected(new Set(filtered.map((e) => e.id)));
  }

  return (
    <div className="p-4 lg:p-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold text-ink">Expenses</h1>
          {actionNeeded > 0 && (
            <p className="mt-1 flex items-center gap-1 text-sm font-medium text-amber-700">
              <AlertCircle className="h-4 w-4" />
              {actionNeeded} expense{actionNeeded !== 1 ? 's' : ''} need{actionNeeded === 1 ? 's' : ''} your reply
            </p>
          )}
        </div>
        <Link
          to="/transactions/new"
          className="flex shrink-0 items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          <Plus className="h-4 w-4" />
          Add Transaction
        </Link>
      </div>

      {/* Summary strip */}
      {!isLoading && expenses.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
            <p className="text-xs font-medium text-gray-500">Showing total</p>
            <p className="mt-0.5 text-xl font-bold text-gray-900">
              ${totalSpent.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
            <p className="text-xs font-medium text-gray-500">Matching</p>
            <p className="mt-0.5 text-xl font-bold text-gray-900">{filtered.length}</p>
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 col-span-2 sm:col-span-1">
            <p className="text-xs font-medium text-amber-800">Needs reply</p>
            <p className="mt-0.5 text-xl font-bold text-amber-900">{actionNeeded}</p>
          </div>
        </div>
      )}

      {/* Status tabs */}
      <div className="mb-3 flex flex-wrap gap-1 rounded-lg border border-gray-200 bg-gray-100 p-1">
        {STATUS_TABS.map((t) => {
          const count = tabCounts[t.id];
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                active
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              {t.label}
              <span
                className={`rounded-full px-1.5 py-0.5 text-xs ${
                  active ? 'bg-brand-50 text-brand-700' : 'bg-gray-200/80 text-gray-500'
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Reimbursement chips */}
      {hasReimbursements && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-gray-400">Reimbursements</span>
          {REIMB_CHIPS.map((c) => {
            const active = reimbFilter === c.id;
            return (
              <button
                key={c.label}
                type="button"
                onClick={() => setReimbFilter(c.id)}
                className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                  active
                    ? 'border-brand-300 bg-brand-100 text-brand-800'
                    : 'border-gray-200 bg-gray-50 text-gray-500 hover:bg-gray-100'
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Filters */}
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search merchant, category, notes…"
            className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
        </div>
        <select
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          <option value="">All months</option>
          {monthOptions.map((ym) => (
            <option key={ym} value={ym}>{formatMonthLabel(ym)}</option>
          ))}
        </select>
        <select
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          <option value="">All categories</option>
          {categoryOptions.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        {sourceOptions.length > 0 && (
          <select
            value={sourceApp}
            onChange={(e) => setSourceApp(e.target.value)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            <option value="">All sources</option>
            {sourceOptions.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        )}
        {(query || month || categoryId || sourceApp || reimbFilter || tab !== 'all') && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setMonth('');
              setCategoryId('');
              setSourceApp('');
              setReimbFilter('');
              setTab('all');
            }}
            className="rounded-lg px-3 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-800"
          >
            Clear
          </button>
        )}
      </div>

      {canBulkDelete && selected.size > 0 && (
        <div className="mb-3 flex flex-col gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-red-900">
            <span className="font-semibold">{selected.size}</span> selected
            {filtered.length > selected.size && (
              <button
                type="button"
                onClick={selectAllFiltered}
                className="ml-2 font-medium text-red-700 underline hover:text-red-900"
              >
                Select all {filtered.length} matching
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {isAdmin && selectedHasZoho && (
              <label className="inline-flex items-center gap-1.5 text-xs text-red-800">
                <input
                  type="checkbox"
                  checked={forceZoho}
                  onChange={(e) => setForceZoho(e.target.checked)}
                />
                Force Zoho-linked
              </label>
            )}
            <button
              type="button"
              disabled={bulkDeleteMutation.isPending || (selectedHasZoho && !(isAdmin && forceZoho))}
              onClick={() => {
                if (!window.confirm(`Delete ${selected.size} expense(s)? This cannot be undone.`)) return;
                bulkDeleteMutation.mutate();
              }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
              {bulkDeleteMutation.isPending ? 'Deleting…' : 'Delete selected'}
            </button>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-gray-200 bg-white">
        {isLoading ? (
          <div className="px-6 py-12 text-center text-sm text-gray-400">Loading…</div>
        ) : expenses.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-gray-500">No expenses yet.</p>
            <Link to="/transactions/new" className="mt-2 inline-block text-sm text-brand-600 hover:underline">
              Create your first expense
            </Link>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-gray-500">
            No expenses match these filters.
          </div>
        ) : (
          <>
            {/* Mobile: stacked cards */}
            <div className="divide-y divide-gray-100 md:hidden">
              {pageRows.map((expense) => (
                <Link
                  key={expense.id}
                  to={`/expenses/${expense.id}`}
                  className={`block px-4 py-3 active:bg-gray-50 ${expense.status === 'awaiting_info' ? 'bg-amber-50' : ''}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="min-w-0 truncate font-medium text-gray-900">{expense.merchant}</p>
                    <p className="shrink-0 font-semibold text-gray-900">
                      {expense.currency} {Number(expense.amount).toFixed(2)}
                    </p>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-3">
                    <p className="text-xs text-gray-500">{expense.date}{expense.category?.name ? ` · ${expense.category.name}` : ''}</p>
                    <div className="flex shrink-0 items-center gap-1">
                      <ReimbursementBadge status={expense.reimbursementStatus} />
                      <StatusBadge status={expense.status} variant="user" zohoExpenseId={expense.zohoExpenseId} />
                    </div>
                  </div>
                </Link>
              ))}
            </div>

            {/* Desktop: full table */}
            <table className="hidden w-full text-sm md:table">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                  {canBulkDelete && (
                    <th className="w-10 px-4 py-3">
                      <input
                        type="checkbox"
                        checked={allPageSelected}
                        onChange={togglePage}
                        aria-label="Select all on page"
                      />
                    </th>
                  )}
                  <th className="px-6 py-3">Merchant</th>
                  <th className="px-6 py-3">Date</th>
                  <th className="px-6 py-3">Category</th>
                  <th className="px-6 py-3 text-right">Amount</th>
                  <th className="px-6 py-3">Status</th>
                  <th className="px-6 py-3">Receipt</th>
                  <th className="px-6 py-3">Next action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {pageRows.map((expense) => (
                  <tr key={expense.id} className={`hover:bg-gray-50 ${expense.status === 'awaiting_info' ? 'bg-amber-50' : ''}`}>
                    {canBulkDelete && (
                      <td className="px-4 py-4">
                        <input
                          type="checkbox"
                          checked={selected.has(expense.id)}
                          onChange={() => toggleOne(expense.id)}
                          aria-label={`Select ${expense.merchant}`}
                        />
                      </td>
                    )}
                    <td className="px-6 py-4">
                      <Link to={`/expenses/${expense.id}`} className="font-medium text-gray-900 hover:text-brand-700">
                        {expense.merchant}
                      </Link>
                      {expense.description && (
                        <p className="mt-0.5 text-xs text-gray-400 line-clamp-1">{expense.description}</p>
                      )}
                      {expense.sourceApp === 'browser_extension' && (
                        <span className="mt-0.5 inline-block rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700">Extension</span>
                      )}
                      {expense.sourceLabel && expense.sourceApp && expense.sourceApp !== 'browser_extension' && (
                        <p className="mt-0.5 text-xs text-gray-400 line-clamp-1">{expense.sourceLabel}</p>
                      )}
                    </td>
                    <td className="px-6 py-4 text-gray-600">{expense.date}</td>
                    <td className="px-6 py-4 text-gray-600">{expense.category?.name ?? '—'}</td>
                    <td className="px-6 py-4 text-right font-medium text-gray-900">
                      {expense.currency} {Number(expense.amount).toFixed(2)}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-col items-start gap-1">
                        <StatusBadge status={expense.status} variant="user" zohoExpenseId={expense.zohoExpenseId} />
                        <ReimbursementBadge status={expense.reimbursementStatus} />
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <ReceiptDetailsButton
                        expenseId={expense.id}
                        receipts={expense.receipts}
                        onOpen={setQuickViewId}
                      />
                    </td>
                    <td className="px-6 py-4 text-sm">
                      <NextActionCell expense={expense} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="flex flex-col gap-2 border-t border-gray-100 px-6 py-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-gray-500">
                Showing {pageStart + 1} to {Math.min(pageStart + PAGE_SIZE, filtered.length)} of {filtered.length} expenses
              </p>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={safePage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  Prev
                </button>
                <span className="px-2 text-xs text-gray-500">
                  Page {safePage} of {totalPages}
                </span>
                <button
                  type="button"
                  disabled={safePage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Next
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {quickViewId && (
        <ExpenseQuickViewModal
          expenseId={quickViewId}
          onClose={() => setQuickViewId(null)}
          onDeleted={() => void qc.invalidateQueries({ queryKey: ['expenses'] })}
        />
      )}
    </div>
  );
}
