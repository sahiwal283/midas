import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Plus, AlertCircle, ChevronDown, ChevronLeft, ChevronRight, Search, SlidersHorizontal, Tent, Trash2, X } from 'lucide-react';
import { expenseApi } from '../api/expenses';
import { StatusBadge, ReimbursementBadge, REIMBURSEMENT_OPTIONS } from '../components/StatusBadge';
import { ReceiptDetailsButton } from '../components/ReceiptDetailsButton';
import { ExpenseQuickViewModal } from '../components/ExpenseQuickViewModal';
import { CategoryPicker } from '../components/CategoryPicker';
import { PageHeader } from '../components/PageHeader';
import { useAuth } from '../contexts/AuthContext';
import type { Expense } from '../types';
import { flattenTree, descendantIdSet } from '../lib/categoryTree';
import { isDailyExpense } from '../lib/expenseScope';
import { roleAllowed } from '../lib/roles';

const PAGE_SIZE = 10;

type StatusTab = 'all' | 'needs_reply' | 'under_review' | 'approved' | 'rejected' | 'draft';

type ExpenseType = '' | 'trade_show' | 'daily';

const STATUS_TABS: Array<{ id: StatusTab; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'needs_reply', label: 'Needs reply' },
  { id: 'under_review', label: 'Under review' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'draft', label: 'Drafts' },
];

const TYPE_OPTIONS: Array<{ id: ExpenseType; label: string }> = [
  { id: '', label: 'All' },
  { id: 'trade_show', label: 'Trade Show' },
  { id: 'daily', label: 'Daily' },
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

// ── Filters ───────────────────────────────────────────────────────────────────

interface ListFilters {
  type: ExpenseType;
  from: string;
  to: string;
  amountMin: string;
  amountMax: string;
  categoryId: string;
  event: string;
  paymentMethodId: string;
  sourceApp: string;
  reimbursement: string;
  userId: string;
  company: string;
}

const EMPTY_FILTERS: ListFilters = {
  type: '',
  from: '',
  to: '',
  amountMin: '',
  amountMax: '',
  categoryId: '',
  event: '',
  paymentMethodId: '',
  sourceApp: '',
  reimbursement: '',
  userId: '',
  company: '',
};

function NextActionCell({ expense }: { expense: Expense }) {
  const action = NEXT_ACTION[expense.status];
  if (!action) return <span className="text-charcoal/40">—</span>;

  if (action.urgent) {
    return (
      <Link to={`/expenses/${expense.id}`} className="flex items-center gap-1 text-amber-700 font-medium hover:underline">
        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
        {action.text}
      </Link>
    );
  }
  return <span className="text-muted">{action.text}</span>;
}

/** Trade Show (with event name when known) / Daily tag. */
function ExpenseTypeChip({ expense, compact = false }: { expense: Expense; compact?: boolean }) {
  if (isDailyExpense(expense)) {
    return (
      <span className="inline-flex items-center rounded bg-brand-50 px-1.5 py-0.5 text-xs font-medium text-charcoal/70">
        Daily
      </span>
    );
  }
  const label = !compact && expense.sourceLabel ? expense.sourceLabel : 'Trade Show';
  return (
    <span className="inline-flex max-w-52 items-center gap-1 truncate rounded bg-brand-100 px-1.5 py-0.5 text-xs font-medium text-brand-800">
      <Tent className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}

export function ExpenseList() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { data: expenses = [], isLoading } = useQuery({
    queryKey: ['expenses'],
    queryFn: () => expenseApi.list(),
  });
  const { data: allCategories = [] } = useQuery({
    queryKey: ['expense-categories'],
    queryFn: () => expenseApi.categories(),
    staleTime: 60_000,
  });

  const [tab, setTab] = useState<StatusTab>('all');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<ListFilters>(EMPTY_FILTERS);
  const [panelOpen, setPanelOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [quickViewId, setQuickViewId] = useState<string | null>(null);
  const [forceZoho, setForceZoho] = useState(false);
  const isAdmin = roleAllowed(user?.role, ['admin']);
  const isPrivileged = roleAllowed(user?.role, ['admin', 'accountant']);
  const canBulkDelete = roleAllowed(user?.role, ['admin', 'accountant', 'user']);

  function setFilter<K extends keyof ListFilters>(key: K, value: ListFilters[K]) {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  // Filtering by a parent category includes every descendant.
  const categoryIdSet = useMemo(
    () => (filters.categoryId ? descendantIdSet(allCategories, filters.categoryId) : null),
    [filters.categoryId, allCategories],
  );

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

  // Option lists derived from the loaded data — only offer values that can
  // actually match at least one row.
  const sourceOptions = useMemo(() => {
    const keys = new Set<string>();
    for (const e of expenses) if (e.sourceApp) keys.add(e.sourceApp);
    return [...keys].sort();
  }, [expenses]);

  const eventOptions = useMemo(() => {
    const keys = new Set<string>();
    for (const e of expenses) {
      if (!isDailyExpense(e) && e.sourceLabel) keys.add(e.sourceLabel);
    }
    return [...keys].sort();
  }, [expenses]);

  const paymentOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of expenses) {
      if (e.paymentMethod) {
        map.set(e.paymentMethod.id, `${e.paymentMethod.label}${e.paymentMethod.lastFour ? ` ···${e.paymentMethod.lastFour}` : ''}`);
      }
    }
    return [...map.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [expenses]);

  const employeeOptions = useMemo(() => {
    if (!isPrivileged) return [];
    const map = new Map<string, string>();
    for (const e of expenses) if (e.user) map.set(e.user.id, e.user.name);
    return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [expenses, isPrivileged]);

  const companyOptions = useMemo(() => {
    if (!isPrivileged) return [];
    const keys = new Set<string>();
    for (const e of expenses) if (e.zohoEntity) keys.add(e.zohoEntity);
    return [...keys].sort();
  }, [expenses, isPrivileged]);

  const hasReimbursements = useMemo(
    () => expenses.some((e) => e.reimbursementStatus !== 'not_requested'),
    [expenses],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const min = filters.amountMin !== '' ? Number(filters.amountMin) : null;
    const max = filters.amountMax !== '' ? Number(filters.amountMax) : null;
    return expenses.filter((e) => {
      if (!matchesStatusTab(e, tab)) return false;
      if (filters.type === 'daily' && !isDailyExpense(e)) return false;
      if (filters.type === 'trade_show' && isDailyExpense(e)) return false;
      if (filters.from && e.date < filters.from) return false;
      if (filters.to && e.date > filters.to) return false;
      if (min !== null && Number(e.amount) < min) return false;
      if (max !== null && Number(e.amount) > max) return false;
      if (categoryIdSet && (!e.categoryId || !categoryIdSet.has(e.categoryId))) return false;
      if (filters.event && e.sourceLabel !== filters.event) return false;
      if (filters.paymentMethodId && e.paymentMethodId !== filters.paymentMethodId) return false;
      if (filters.sourceApp && e.sourceApp !== filters.sourceApp) return false;
      if (filters.reimbursement && e.reimbursementStatus !== filters.reimbursement) return false;
      if (filters.userId && e.userId !== filters.userId) return false;
      if (filters.company && e.zohoEntity !== filters.company) return false;
      if (q) {
        const hay = `${e.merchant} ${e.description ?? ''} ${e.category?.name ?? ''} ${e.sourceLabel ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [expenses, tab, filters, categoryIdSet, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pageRows = filtered.slice(pageStart, pageStart + PAGE_SIZE);
  const pageIds = pageRows.map((e) => e.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const selectedHasZoho = [...selected].some((id) => expenses.find((e) => e.id === id)?.zohoExpenseId);

  useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [tab, filters, query]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

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

  // Active-filter chips (Type lives in the segmented toggle, not the panel,
  // but still shows as a chip so one row summarises everything applied).
  const activeChips = useMemo(() => {
    const chips: Array<{ key: keyof ListFilters; label: string }> = [];
    if (filters.type) chips.push({ key: 'type', label: filters.type === 'daily' ? 'Type: Daily' : 'Type: Trade Show' });
    if (filters.from) chips.push({ key: 'from', label: `From ${filters.from}` });
    if (filters.to) chips.push({ key: 'to', label: `To ${filters.to}` });
    if (filters.amountMin) chips.push({ key: 'amountMin', label: `Min $${filters.amountMin}` });
    if (filters.amountMax) chips.push({ key: 'amountMax', label: `Max $${filters.amountMax}` });
    if (filters.categoryId) {
      const name = flattenTree(allCategories).find(({ cat }) => cat.id === filters.categoryId)?.cat.name;
      chips.push({ key: 'categoryId', label: name ?? 'Category' });
    }
    if (filters.event) chips.push({ key: 'event', label: filters.event });
    if (filters.paymentMethodId) {
      const label = paymentOptions.find((p) => p.id === filters.paymentMethodId)?.label;
      chips.push({ key: 'paymentMethodId', label: label ?? 'Payment method' });
    }
    if (filters.sourceApp) chips.push({ key: 'sourceApp', label: `Source: ${filters.sourceApp}` });
    if (filters.reimbursement) {
      const label = REIMBURSEMENT_OPTIONS.find((o) => o.value === filters.reimbursement)?.label;
      chips.push({ key: 'reimbursement', label: `Reimb: ${label ?? filters.reimbursement}` });
    }
    if (filters.userId) {
      const name = employeeOptions.find((e) => e.id === filters.userId)?.name;
      chips.push({ key: 'userId', label: name ?? 'Employee' });
    }
    if (filters.company) chips.push({ key: 'company', label: filters.company });
    return chips;
  }, [filters, allCategories, paymentOptions, employeeOptions]);

  const panelFilterCount = activeChips.filter((c) => c.key !== 'type').length;

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

  const fieldClass = 'field';
  const labelClass = 'field-label';

  return (
    <div className="page">
      <PageHeader
        title="Expenses"
        subtitle={
          actionNeeded > 0 ? (
            <span className="flex items-center gap-1 font-medium text-amber-800">
              <AlertCircle className="h-4 w-4" />
              {actionNeeded} expense{actionNeeded !== 1 ? 's' : ''} need{actionNeeded === 1 ? 's' : ''} your reply
            </span>
          ) : undefined
        }
        actions={
          <Link to="/transactions/new" className="btn-primary">
            <Plus className="h-4 w-4" />
            Add Transaction
          </Link>
        }
      />

      {/* Summary strip */}
      {!isLoading && expenses.length > 0 && (
        <div className="mb-4 grid grid-cols-3 gap-2 sm:gap-3">
          <div className="rounded-xl border border-ink/10 bg-white px-3 py-2.5 shadow-panel sm:px-4 sm:py-3">
            <p className="text-xs font-medium text-muted">Showing total</p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums text-ink sm:text-xl">
              ${totalSpent.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
          <div className="rounded-xl border border-ink/10 bg-white px-3 py-2.5 shadow-panel sm:px-4 sm:py-3">
            <p className="text-xs font-medium text-muted">Matching</p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums text-ink sm:text-xl">{filtered.length}</p>
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 sm:px-4 sm:py-3">
            <p className="text-xs font-medium text-amber-800">Needs reply</p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums text-amber-900 sm:text-xl">{actionNeeded}</p>
          </div>
        </div>
      )}

      {/* Status tabs — single scrollable row on phones so they never stack */}
      <div className="mb-3 flex gap-1 overflow-x-auto rounded-lg border border-ink/10 bg-brand-50 p-1 sm:flex-wrap sm:overflow-visible">
        {STATUS_TABS.map((t) => {
          const count = tabCounts[t.id];
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                active
                  ? 'bg-white text-ink shadow-sm'
                  : 'text-charcoal/70 hover:text-ink'
              }`}
            >
              {t.label}
              <span
                className={`rounded-full px-1.5 py-0.5 text-xs ${
                  active ? 'bg-brand-50 text-brand-700' : 'bg-ink/10 text-muted'
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Toolbar — search + type toggle always visible, everything else in the panel */}
      <div className="mb-3 rounded-xl border border-ink/10 bg-white p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 basis-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-charcoal/40" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search merchant, category, event, notes…"
              className="w-full min-h-11 rounded-lg border border-ink/10 bg-white py-2 pl-9 pr-3 text-sm text-ink placeholder:text-charcoal/40 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 md:min-h-0"
            />
          </div>
          <div className="flex shrink-0 rounded-lg border border-ink/10 bg-brand-50 p-0.5">
            {TYPE_OPTIONS.map((t) => (
              <button
                key={t.label}
                type="button"
                onClick={() => setFilter('type', t.id)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  filters.type === t.id
                    ? 'bg-white text-ink shadow-sm'
                    : 'text-muted hover:text-ink'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setPanelOpen((o) => !o)}
            aria-expanded={panelOpen}
            className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-ink/10 px-3 py-2 text-sm font-medium text-charcoal/80 hover:bg-ink/[0.03] md:min-h-0"
          >
            <SlidersHorizontal className="h-4 w-4" />
            Filters
            {panelFilterCount > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-500 px-1 text-xs font-semibold text-cream">
                {panelFilterCount}
              </span>
            )}
            <ChevronDown className={`h-4 w-4 text-charcoal/40 transition-transform ${panelOpen ? 'rotate-180' : ''}`} />
          </button>
        </div>

        {panelOpen && (
          <div className="mt-3 grid grid-cols-1 gap-3 border-t border-ink/5 pt-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <span className={labelClass}>Date range</span>
              <div className="flex items-center gap-1.5">
                <input type="date" value={filters.from} onChange={(e) => setFilter('from', e.target.value)} className={fieldClass} aria-label="Date from" />
                <span className="text-xs text-charcoal/40">to</span>
                <input type="date" value={filters.to} onChange={(e) => setFilter('to', e.target.value)} className={fieldClass} aria-label="Date to" />
              </div>
            </div>
            <div>
              <span className={labelClass}>Amount</span>
              <div className="flex items-center gap-1.5">
                <input type="number" min="0" step="0.01" value={filters.amountMin} onChange={(e) => setFilter('amountMin', e.target.value)} placeholder="Min $" className={fieldClass} aria-label="Amount minimum" />
                <span className="text-xs text-charcoal/40">–</span>
                <input type="number" min="0" step="0.01" value={filters.amountMax} onChange={(e) => setFilter('amountMax', e.target.value)} placeholder="Max $" className={fieldClass} aria-label="Amount maximum" />
              </div>
            </div>
            <div className="relative z-10">
              <span className={labelClass}>Category</span>
              <CategoryPicker
                categories={allCategories}
                value={filters.categoryId}
                onChange={(id) => setFilter('categoryId', id)}
                placeholder="All categories"
                emptyLabel="All categories"
                inputClassName={fieldClass}
              />
            </div>
            {eventOptions.length > 0 && (
              <div>
                <span className={labelClass}>Event</span>
                <select value={filters.event} onChange={(e) => setFilter('event', e.target.value)} className={fieldClass}>
                  <option value="">All events</option>
                  {eventOptions.map((ev) => (
                    <option key={ev} value={ev}>{ev}</option>
                  ))}
                </select>
              </div>
            )}
            {paymentOptions.length > 0 && (
              <div>
                <span className={labelClass}>Payment method</span>
                <select value={filters.paymentMethodId} onChange={(e) => setFilter('paymentMethodId', e.target.value)} className={fieldClass}>
                  <option value="">All payment methods</option>
                  {paymentOptions.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </div>
            )}
            {sourceOptions.length > 0 && (
              <div>
                <span className={labelClass}>Source</span>
                <select value={filters.sourceApp} onChange={(e) => setFilter('sourceApp', e.target.value)} className={fieldClass}>
                  <option value="">All sources</option>
                  {sourceOptions.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            )}
            {hasReimbursements && (
              <div>
                <span className={labelClass}>Reimbursement</span>
                <select value={filters.reimbursement} onChange={(e) => setFilter('reimbursement', e.target.value)} className={fieldClass}>
                  <option value="">Any</option>
                  {REIMBURSEMENT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            )}
            {employeeOptions.length > 0 && (
              <div>
                <span className={labelClass}>Employee</span>
                <select value={filters.userId} onChange={(e) => setFilter('userId', e.target.value)} className={fieldClass}>
                  <option value="">All employees</option>
                  {employeeOptions.map((emp) => (
                    <option key={emp.id} value={emp.id}>{emp.name}</option>
                  ))}
                </select>
              </div>
            )}
            {companyOptions.length > 0 && (
              <div>
                <span className={labelClass}>Company</span>
                <select value={filters.company} onChange={(e) => setFilter('company', e.target.value)} className={fieldClass}>
                  <option value="">All companies</option>
                  {companyOptions.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        {(activeChips.length > 0 || query || tab !== 'all') && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {activeChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={() => setFilter(chip.key, '')}
                className="inline-flex items-center gap-1 rounded-full border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-800 hover:bg-brand-100"
              >
                {chip.label}
                <X className="h-3 w-3" />
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setQuery('');
                setTab('all');
              }}
              className="rounded-full px-2.5 py-1 text-xs font-medium text-muted hover:bg-brand-50 hover:text-ink"
            >
              Clear all
            </button>
          </div>
        )}
      </div>

      {canBulkDelete && selected.size > 0 && (
        <div className="mb-3 flex flex-col gap-2 rounded-xl border border-danger/25 bg-danger/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-danger">
            <span className="font-semibold">{selected.size}</span> selected
            {filtered.length > selected.size && (
              <button
                type="button"
                onClick={selectAllFiltered}
                className="ml-2 font-medium text-danger underline hover:text-danger"
              >
                Select all {filtered.length} matching
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {isAdmin && selectedHasZoho && (
              <label className="inline-flex items-center gap-1.5 text-xs text-danger">
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
              className="inline-flex items-center gap-1.5 rounded-lg bg-danger px-3 py-1.5 text-sm font-semibold text-cream hover:bg-danger disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
              {bulkDeleteMutation.isPending ? 'Deleting…' : 'Delete selected'}
            </button>
          </div>
        </div>
      )}

      <div className="panel">
        {isLoading ? (
          <div className="px-6 py-12 text-center text-sm text-charcoal/40">Loading…</div>
        ) : expenses.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-muted">No expenses yet.</p>
            <Link to="/transactions/new" className="mt-2 inline-block text-sm text-brand-600 hover:underline">
              Create your first expense
            </Link>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-muted">
            No expenses match these filters.
          </div>
        ) : (
          <>
            {/* Mobile: stacked cards */}
            <div className="divide-y divide-ink/5 md:hidden">
              {pageRows.map((expense) => (
                <Link
                  key={expense.id}
                  to={`/expenses/${expense.id}`}
                  className={`block px-4 py-3 active:bg-ink/[0.03] ${expense.status === 'awaiting_info' ? 'bg-amber-50' : ''}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="min-w-0 truncate font-medium text-ink">{expense.merchant}</p>
                    <p className="shrink-0 font-semibold tabular-nums text-ink">
                      {expense.currency} {Number(expense.amount).toFixed(2)}
                    </p>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <ExpenseTypeChip expense={expense} compact />
                      <p className="min-w-0 truncate text-xs text-muted">{expense.date}{expense.category?.name ? ` · ${expense.category.name}` : ''}</p>
                    </div>
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
              <tr className="border-b border-ink/10 bg-brand-50/80 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
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
                  <th className="px-6 py-3">Type</th>
                  <th className="px-6 py-3">Date</th>
                  <th className="px-6 py-3">Category</th>
                  <th className="px-6 py-3 text-right">Amount</th>
                  <th className="px-6 py-3">Status</th>
                  <th className="px-6 py-3">Receipt</th>
                  <th className="px-6 py-3">Next action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink/5">
                {pageRows.map((expense) => (
                  <tr key={expense.id} className={`hover:bg-ink/[0.03] ${expense.status === 'awaiting_info' ? 'bg-amber-50' : ''}`}>
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
                      <Link to={`/expenses/${expense.id}`} className="font-medium text-ink hover:text-brand-700">
                        {expense.merchant}
                      </Link>
                      {expense.description && (
                        <p className="mt-0.5 text-xs text-charcoal/40 line-clamp-1">{expense.description}</p>
                      )}
                      {expense.sourceApp === 'browser_extension' && (
                        <span className="mt-0.5 inline-block rounded bg-brand-100 px-1.5 py-0.5 text-xs text-brand-700">Extension</span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <ExpenseTypeChip expense={expense} />
                    </td>
                    <td className="px-6 py-4 text-charcoal/70">{expense.date}</td>
                    <td className="px-6 py-4 text-charcoal/70">{expense.category?.name ?? '—'}</td>
                    <td className="px-6 py-4 text-right font-medium tabular-nums text-ink">
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

            <div className="flex flex-col gap-2 border-t border-ink/5 px-6 py-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-muted">
                Showing {pageStart + 1} to {Math.min(pageStart + PAGE_SIZE, filtered.length)} of {filtered.length} expenses
              </p>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={safePage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="inline-flex items-center gap-1 rounded-lg border border-ink/10 bg-white px-2.5 py-1.5 text-xs font-medium text-charcoal/80 hover:bg-ink/[0.03] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  Prev
                </button>
                <span className="px-2 text-xs text-muted">
                  Page {safePage} of {totalPages}
                </span>
                <button
                  type="button"
                  disabled={safePage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="inline-flex items-center gap-1 rounded-lg border border-ink/10 bg-white px-2.5 py-1.5 text-xs font-medium text-charcoal/80 hover:bg-ink/[0.03] disabled:cursor-not-allowed disabled:opacity-40"
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
