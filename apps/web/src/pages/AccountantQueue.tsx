import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertCircle, CheckCircle2, ChevronDown, Clock, RefreshCw, Search as SearchIcon, SlidersHorizontal, Send, FileX, Tag, CreditCard, Building2, Banknote, X } from 'lucide-react';
import { accountantApi, expenseApi } from '../api/expenses';
import { companyApi } from '../api/companies';
import { StatusBadge, ZohoPushBadge, ReimbursementBadge, REIMBURSEMENT_OPTIONS } from '../components/StatusBadge';
import { ZohoErrorCategoryChip } from '../components/ZohoSyncCard';
import { ReceiptDetailsButton } from '../components/ReceiptDetailsButton';
import { ExpenseQuickViewModal } from '../components/ExpenseQuickViewModal';
import { Modal } from '../components/Modal';
import { CategoryPicker } from '../components/CategoryPicker';
import { ExpenseBrowser, ExpenseTypeChip } from '../components/ExpenseBrowser';
import { PageHeader } from '../components/PageHeader';
import { useAuth } from '../contexts/AuthContext';
import type { Expense } from '../types';

// ── Lane definitions ──────────────────────────────────────────────────────────

type LaneId =
  | 'needs_review'
  | 'awaiting_user'
  | 'missing_receipt'
  | 'missing_category'
  | 'missing_payment_method'
  | 'missing_entity'
  | 'ready_for_zoho'
  | 'zoho_failed'
  | 'reimbursement_pending';

interface LaneDef {
  label: string;
  icon: React.ReactNode;
  description: string;
}

const LANES: Record<LaneId, LaneDef> = {
  needs_review: {
    label: 'Pending approval',
    icon: <Clock className="h-3.5 w-3.5" />,
    description: 'Submitted — ready to Approve, Reject, or request further review',
  },
  awaiting_user: {
    label: 'Needs further review',
    icon: <AlertCircle className="h-3.5 w-3.5" />,
    description: 'Accountant asked for more information — waiting on employee',
  },
  missing_receipt: {
    label: 'Missing Receipt',
    icon: <FileX className="h-3.5 w-3.5" />,
    description: 'Approved expenses without a receipt attached',
  },
  missing_category: {
    label: 'Missing Expense Account',
    icon: <Tag className="h-3.5 w-3.5" />,
    description: 'Approved expenses without a Zoho expense account (or Midas category) — cannot push to Zoho',
  },
  missing_payment_method: {
    label: 'Missing Payment',
    icon: <CreditCard className="h-3.5 w-3.5" />,
    description: 'Approved expenses without a payment method — required for Zoho',
  },
  missing_entity: {
    label: 'Missing Company',
    icon: <Building2 className="h-3.5 w-3.5" />,
    description: 'Approved but company not set',
  },
  ready_for_zoho: {
    label: 'Ready for Zoho',
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
    description: 'All required fields complete — ready to push to Zoho.',
  },
  zoho_failed: {
    label: 'Zoho Failed',
    icon: <RefreshCw className="h-3.5 w-3.5" />,
    description: 'Zoho sync failed — needs retry.',
  },
  reimbursement_pending: {
    label: 'Reimbursement',
    icon: <Banknote className="h-3.5 w-3.5" />,
    description: 'Personal-card expenses waiting for reimbursement (needs reimbursement / approved pending payment)',
  },
};

// Flag metadata for inline badges
const FLAG_META: Record<string, { label: string; color: string }> = {
  needs_category: { label: 'No Expense Account', color: 'bg-gold-100 text-gold-800' },
  missing_receipt: { label: 'No Receipt', color: 'bg-danger/15 text-danger' },
  needs_payment_method: { label: 'No Payment', color: 'bg-brand-100 text-brand-800' },
  needs_entity: { label: 'No Company', color: 'bg-brand-100 text-brand-800' },
  ready_for_zoho: { label: 'Ready for Zoho', color: 'bg-success/15 text-success' },
  from_extension: { label: 'Extension', color: 'bg-brand-100 text-brand-700' },
  zoho_synced: { label: 'Synced', color: 'bg-success/15 text-success' },
  reimbursement_pending: { label: 'Reimb. Pending', color: 'bg-gold-100 text-gold-800' },
};

// ── Filters ───────────────────────────────────────────────────────────────────

interface QueueFilters {
  search: string;
  userId: string;
  company: string;
  categoryId: string;
  paymentMethodId: string;
  from: string;
  to: string;
  amountMin: string;
  amountMax: string;
  reimbursementStatus: string;
  zohoStatus: string;
  sourceApp: string;
  event: string;
  ocrNeedsReview: boolean;
  missingReceipt: boolean;
  missingCategory: boolean;
  missingPayment: boolean;
}

const EMPTY_FILTERS: QueueFilters = {
  search: '',
  userId: '',
  company: '',
  categoryId: '',
  paymentMethodId: '',
  from: '',
  to: '',
  amountMin: '',
  amountMax: '',
  reimbursementStatus: '',
  zohoStatus: '',
  sourceApp: '',
  event: '',
  ocrNeedsReview: false,
  missingReceipt: false,
  missingCategory: false,
  missingPayment: false,
};

function filtersToParams(f: QueueFilters): Record<string, string> {
  const params: Record<string, string> = {};
  if (f.search.trim()) params.search = f.search.trim();
  if (f.userId) params.userId = f.userId;
  if (f.company) params.company = f.company;
  if (f.categoryId) params.categoryId = f.categoryId;
  if (f.paymentMethodId) params.paymentMethodId = f.paymentMethodId;
  if (f.from) params.from = f.from;
  if (f.to) params.to = f.to;
  if (f.amountMin) params.amountMin = f.amountMin;
  if (f.amountMax) params.amountMax = f.amountMax;
  if (f.reimbursementStatus) params.reimbursementStatus = f.reimbursementStatus;
  if (f.zohoStatus) params.zohoStatus = f.zohoStatus;
  if (f.sourceApp) params.sourceApp = f.sourceApp;
  if (f.event) params.event = f.event;
  if (f.ocrNeedsReview) params.ocrNeedsReview = 'true';
  if (f.missingReceipt) params.missingReceipt = 'true';
  if (f.missingCategory) params.missingCategory = 'true';
  if (f.missingPayment) params.missingPayment = 'true';
  return params;
}

const PAGE_SIZE = 50;

/** Map review lanes to server filters so pagination is meaningful. */
function laneToServerParams(lane: LaneId): Record<string, string> {
  switch (lane) {
    case 'needs_review':
      return { status: 'needs_review' };
    case 'awaiting_user':
      return { status: 'awaiting_info' };
    case 'missing_receipt':
      return { status: 'approved', missingReceipt: 'true' };
    case 'missing_category':
      return { status: 'approved', missingCategory: 'true' };
    case 'missing_payment_method':
      return { status: 'approved', missingPayment: 'true' };
    case 'missing_entity':
      return { missingEntity: 'true' };
    case 'ready_for_zoho':
      return { readyForZoho: 'true' };
    case 'zoho_failed':
      return { status: 'zoho_sync_failed' };
    case 'reimbursement_pending':
      return { reimbursementOpen: 'true' };
    default: {
      const _exhaustive: never = lane;
      return _exhaustive;
    }
  }
}

function fmtMoney(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function humanizeSourceApp(app: string): string {
  return app
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ── Main component ────────────────────────────────────────────────────────────

export function AccountantQueue({ scope }: { scope: 'event' | 'daily' }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  // Queue = the review lanes; All = every expense in this page's scope,
  // browsed with the same list/filters as My Expenses. URL-backed so the
  // choice is linkable and survives refresh.
  const view: 'queue' | 'all' = searchParams.get('view') === 'all' ? 'all' : 'queue';
  function setView(next: 'queue' | 'all') {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      if (next === 'all') p.set('view', 'all');
      else p.delete('view');
      return p;
    }, { replace: true });
  }
  const [activeLane, setActiveLane] = useState<LaneId>(() => {
    const fromUrl = searchParams.get('status');
    return fromUrl && fromUrl in LANES ? (fromUrl as LaneId) : 'needs_review';
  });
  const [quickViewId, setQuickViewId] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  // Filter bar state (search input is debounced before hitting the server)
  const [filters, setFilters] = useState<QueueFilters>(() => {
    const reimbursementStatus = searchParams.get('reimbursementStatus');
    return reimbursementStatus ? { ...EMPTY_FILTERS, reimbursementStatus } : EMPTY_FILTERS;
  });
  const [searchInput, setSearchInput] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => (f.search === searchInput ? f : { ...f, search: searchInput }));
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
  }, [activeLane, filters]);

  const queryParams = useMemo(() => {
    const base: Record<string, string> = { ...filtersToParams(filters), ...laneToServerParams(activeLane), scope };
    base.page = String(page);
    base.pageSize = String(PAGE_SIZE);
    return base;
  }, [filters, activeLane, page, scope]);
  const hasActiveFilters = Object.keys(filtersToParams(filters)).length > 0;
  // The queue stays above the fold at every size: everything but search
  // collapses behind a Filters toggle. Search is excluded from the badge count
  // because it stays visible in the collapsed row.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilterCount = Object.keys(filtersToParams(filters)).filter((k) => k !== 'search').length;

  // Bulk selection + result toasts
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showApproveModal, setShowApproveModal] = useState(false);
  const [toast, setToast] = useState<{ text: string; details?: string[] } | null>(null);

  const { data: queuePage, isLoading: queueLoading } = useQuery({
    queryKey: ['accountant-queue', scope, queryParams],
    queryFn: () => accountantApi.queue(queryParams),
    enabled: view === 'queue',
  });
  const queue = queuePage?.expenses ?? [];

  // /accountant/queue/summary does not take a scope param — it always returns
  // both scopes combined via `byScope`. We still key the query by scope so
  // the two pages don't share a cached selection, and read `byScope[scope]`
  // below for this page's lane badges.
  const { data: queueSummary } = useQuery({
    queryKey: ['accountant-queue-summary', scope],
    queryFn: () => accountantApi.queueSummary(),
    staleTime: 30_000,
  });

  const { data: employees = [] } = useQuery({
    queryKey: ['accountant-employees'],
    queryFn: () => accountantApi.employees(),
    staleTime: 60_000,
  });

  const { data: companies = [] } = useQuery({
    queryKey: ['companies'],
    queryFn: () => companyApi.list(),
    staleTime: 60_000,
  });

  const { data: categories = [] } = useQuery({
    queryKey: ['expense-categories'],
    queryFn: () => expenseApi.categories(),
    staleTime: 60_000,
  });

  const { data: paymentMethods = [] } = useQuery({
    queryKey: ['payment-methods'],
    queryFn: () => expenseApi.paymentMethods(),
    staleTime: 60_000,
  });

  // Events across the whole queue, not just this page of rows — only the event
  // page has them, so the daily page never pays for the request.
  const { data: queueEvents = [] } = useQuery({
    queryKey: ['accountant-queue-events', scope],
    queryFn: () => accountantApi.queueEvents({ scope }),
    enabled: scope === 'event',
    staleTime: 60_000,
  });

  // One removable chip per applied filter — keeps applied state visible while
  // the panel itself stays collapsed.
  const activeChips = useMemo(() => {
    const chips: Array<{ key: string; label: string; clear: () => void }> = [];
    const add = (key: keyof QueueFilters, label: string, cleared: string | boolean = '') =>
      chips.push({ key, label, clear: () => setFilters((f) => ({ ...f, [key]: cleared })) });
    if (filters.userId) add('userId', employees.find((e) => e.id === filters.userId)?.name ?? 'Employee');
    if (filters.company) add('company', filters.company);
    if (filters.categoryId) add('categoryId', categories.find((c) => c.id === filters.categoryId)?.name ?? 'Category');
    if (filters.paymentMethodId) add('paymentMethodId', paymentMethods.find((p) => p.id === filters.paymentMethodId)?.label ?? 'Payment method');
    if (filters.from) add('from', `From ${filters.from}`);
    if (filters.to) add('to', `To ${filters.to}`);
    if (filters.amountMin) add('amountMin', `Min $${filters.amountMin}`);
    if (filters.amountMax) add('amountMax', `Max $${filters.amountMax}`);
    if (filters.reimbursementStatus) {
      add('reimbursementStatus', `Reimb: ${REIMBURSEMENT_OPTIONS.find((o) => o.value === filters.reimbursementStatus)?.label ?? filters.reimbursementStatus}`);
    }
    if (filters.zohoStatus) add('zohoStatus', `Zoho: ${filters.zohoStatus.replace(/_/g, ' ')}`);
    if (filters.sourceApp) add('sourceApp', humanizeSourceApp(filters.sourceApp));
    if (filters.event) add('event', filters.event);
    if (filters.ocrNeedsReview) add('ocrNeedsReview', 'OCR needs review', false);
    if (filters.missingReceipt) add('missingReceipt', 'Missing receipt', false);
    if (filters.missingCategory) add('missingCategory', 'Missing category', false);
    if (filters.missingPayment) add('missingPayment', 'Missing payment', false);
    return chips;
  }, [filters, employees, categories, paymentMethods]);

  const { data: zohoHealth } = useQuery({
    queryKey: ['zoho-service-health'],
    queryFn: () => accountantApi.zohoServiceHealth(),
    staleTime: 60_000,
  });

  const zohoPushSuffix = !zohoHealth
    ? ''
    : zohoHealth.readyForLivePush
      ? ''
      : zohoHealth.zohoMode === 'mock'
        ? ' [mock]'
        : zohoHealth.dryRun
          ? ' [dry-run]'
          : zohoHealth.zohoAuth?.ok === false
            ? ' [blocked]'
            : '';

  const zohoLaneNote = !zohoHealth
    ? null
    : zohoHealth.readyForLivePush
      ? 'Live Zoho writes are enabled.'
      : zohoHealth.zohoMode === 'mock'
        ? 'Zoho is in mock mode: no real sync will occur.'
        : zohoHealth.dryRun
          ? 'Zoho dry-run is on: Midas will not POST create_books.'
          : zohoHealth.zohoAuth?.ok === false
            ? `Zoho Integration Service auth blocked (${zohoHealth.zohoAuth.code ?? 'error'}): ${zohoHealth.zohoAuth.message ?? 'Authorization required'}.`
            : 'Zoho service is not ready for live push.';

  const { data: allExpenses = [], isLoading: allLoading } = useQuery({
    queryKey: ['accountant-all', scope],
    queryFn: () => accountantApi.all({ scope }),
    enabled: view === 'all',
  });

  function refetchQueueAndSummary() {
    qc.invalidateQueries({ queryKey: ['accountant-queue'] });
    qc.invalidateQueries({ queryKey: ['accountant-all'] });
    qc.invalidateQueries({ queryKey: ['accountant-queue-summary'] });
  }

  const reviewMutation = useMutation({
    mutationFn: ({ id, action, note, requestType, internalNote }: {
      id: string;
      action: 'approve' | 'reject' | 'request_info';
      note?: string;
      requestType?: string;
      internalNote?: string;
    }) => accountantApi.review(id, { action, note, requestType, internalNote }),
    onSuccess: refetchQueueAndSummary,
  });

  const resolveMutation = useMutation({
    mutationFn: (id: string) => accountantApi.resolveRequest(id),
    onSuccess: refetchQueueAndSummary,
  });

  const zohoMutation = useMutation({
    mutationFn: (id: string) => accountantApi.pushToZoho(id),
    onSuccess: () => {
      setToast({ text: 'Pushed to Zoho.' });
      refetchQueueAndSummary();
    },
    onError: (err: any) => {
      setToast({
        text: 'Zoho push failed.',
        details: [err?.response?.data?.error?.message ?? 'Unknown error'],
      });
    },
  });

  const bulkApproveMutation = useMutation({
    mutationFn: ({ ids }: { ids: string[]; flaggedCount: number }) =>
      accountantApi.bulkReview(ids),
    onSuccess: (result, variables) => {
      const skippedTotal = result.skipped.length + variables.flaggedCount;
      setToast({
        text: `Approved ${result.approved.length}. Skipped ${skippedTotal}.`,
        details: result.skipped.length > 0
          ? result.skipped.map((s) => {
              const row = queue.find((e) => e.id === s.id);
              return `${row?.merchant ?? s.id}: ${s.reason}`;
            })
          : undefined,
      });
      setSelected(new Set());
      setShowApproveModal(false);
      refetchQueueAndSummary();
    },
    onError: () => {
      setToast({ text: 'Bulk approval failed. No expenses were changed.' });
      setShowApproveModal(false);
    },
  });

  const bulkPushMutation = useMutation({
    mutationFn: (ids: string[]) => accountantApi.bulkZohoPush(ids),
    onSuccess: (result) => {
      const parts = [`${result.pushed.length} synced`];
      if (result.failed.length > 0) parts.push(`${result.failed.length} require${result.failed.length === 1 ? 's' : ''} attention`);
      setToast({
        text: parts.join(', '),
        details: result.failed.length > 0
          ? result.failed.map((f) => {
              const row = queue.find((e) => e.id === f.id);
              return `${row?.merchant ?? f.id}: ${f.message}`;
            })
          : undefined,
      });
      refetchQueueAndSummary();
    },
    onError: () => {
      setToast({ text: 'Bulk Zoho push failed.' });
    },
  });

  // Lane counts from summary (accurate with pagination) — scoped to this page
  const counts = queueSummary?.byScope?.[scope]?.counts ?? {};
  const laneCounts: Partial<Record<LaneId, number>> = {
    needs_review: (counts.pending ?? 0) + (counts.in_review ?? 0),
    awaiting_user: counts.awaiting_info ?? 0,
    missing_receipt: counts.missing_receipt ?? 0,
    missing_category: counts.needs_category ?? 0,
    missing_payment_method: counts.needs_payment_method ?? 0,
    missing_entity: counts.needs_entity ?? 0,
    ready_for_zoho: counts.ready_for_zoho ?? 0,
    zoho_failed: counts.zoho_sync_failed ?? 0,
    reimbursement_pending: counts.reimbursement_pending ?? 0,
  };
  const sourceData = queue;
  const totalActive = (laneCounts.needs_review ?? 0)
    + (laneCounts.awaiting_user ?? 0)
    + (laneCounts.ready_for_zoho ?? 0)
    + (laneCounts.zoho_failed ?? 0);

  const displayData = queue;

  const isLoading = queueLoading;
  const totalPages = queuePage?.totalPages ?? 1;
  const totalRows = queuePage?.total ?? displayData.length;
  const pageFrom = totalRows === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const pageTo = Math.min(page * PAGE_SIZE, totalRows);

  const readyLaneCount = laneCounts.ready_for_zoho ?? 0;
  const readyLaneAmount = queueSummary?.byScope?.[scope]?.readyForZohoAmount ?? 0;

  // Bulk selection — resolved against currently loaded rows
  const selectedRows = sourceData.filter((e) => selected.has(e.id));
  const selectedTotal = selectedRows.reduce((sum, e) => sum + Number(e.amount || 0), 0);
  const allOnPageSelected = displayData.length > 0 && displayData.every((e) => selected.has(e.id));

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllOnPage() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        for (const e of displayData) next.delete(e.id);
      } else {
        for (const e of displayData) next.add(e.id);
      }
      return next;
    });
  }

  // Ready-for-Zoho card — totals from the summary (the whole lane), push is this page.
  const readyRows = activeLane === 'ready_for_zoho' ? displayData : [];
  const readyTotal = readyLaneAmount;

  // Source app options for the filter — scoped so this page never offers a
  // value that is guaranteed to return zero rows here. `browser_extension`
  // only exists in the daily bucket; every other sourceApp lives in the
  // event bucket (see lib/queueScope.ts isDailyExpense).
  const sourceAppOptions = useMemo(() => {
    const seed = scope === 'daily' ? ['browser_extension'] : [];
    const set = new Set<string>(seed);
    for (const e of queue) if (e.sourceApp) set.add(e.sourceApp);
    return [...set].sort();
  }, [queue, scope]);

  // Event names come from the server so the list covers the whole queue, not
  // just the current page. A selected event that has since left the queue is
  // kept in the list — otherwise the select would render blank while still
  // filtering.
  const eventOptions = useMemo(() => {
    const names = queueEvents.map((e) => e.name);
    if (filters.event && !names.includes(filters.event)) names.unshift(filters.event);
    return names;
  }, [queueEvents, filters.event]);

  function clearFilters() {
    setFilters(EMPTY_FILTERS);
    setSearchInput('');
  }

  function setFilter<K extends keyof QueueFilters>(key: K, value: QueueFilters[K]) {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  const filterSelectClass = 'min-h-11 rounded-lg border border-ink/15 bg-white px-2 py-1.5 text-sm text-charcoal/80 focus:border-brand-500 focus:outline-none md:min-h-0';
  const filterInputClass = 'min-h-11 rounded-lg border border-ink/15 px-2 py-1.5 text-sm text-charcoal/80 focus:border-brand-500 focus:outline-none md:min-h-0';

  const title = scope === 'event' ? 'Event Review' : 'Daily Review';
  const subtitle = scope === 'event'
    ? 'Expenses submitted from trade shows and other connected apps.'
    : 'Expenses entered in Midas or captured with the browser extension.';

  return (
    <div className="page">
      <PageHeader
        title={title}
        subtitle={
          <>
            {subtitle}
            <span className="mt-0.5 block">
              {totalActive > 0
                ? `${totalActive.toLocaleString()} item${totalActive !== 1 ? 's' : ''} need attention`
                : 'All queues clear — nothing urgent.'}
            </span>
          </>
        }
        actions={
          <Link to="/integration-health" className="btn-secondary">
            Integration health
          </Link>
        }
      />

      {/* Queue vs full-list toggle — same pattern as the Reports page */}
      <div
        role="radiogroup"
        aria-label="Review view"
        className="mb-5 inline-flex rounded-full border border-ink/10 bg-brand-50 p-1"
      >
        {(['queue', 'all'] as const).map((v) => {
          const active = view === v;
          return (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setView(v)}
              className={`min-h-11 cursor-pointer rounded-full px-5 py-2 text-sm font-semibold transition-colors duration-200 lg:min-h-0 ${
                active
                  ? 'bg-brand-500 text-cream shadow-sm'
                  : 'text-charcoal/70 hover:text-ink'
              }`}
            >
              {v === 'queue' ? 'Queue' : 'All'}
            </button>
          );
        })}
      </div>

      {/* Result toast */}
      {toast && (
        <div className="mb-4 rounded-xl border border-success/30 bg-success/10 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-ink">{toast.text}</p>
              {toast.details && toast.details.length > 0 && (
                <ul className="mt-1.5 space-y-0.5">
                  {toast.details.map((d, i) => (
                    <li key={i} className="text-xs text-success">• {d}</li>
                  ))}
                </ul>
              )}
            </div>
            <button onClick={() => setToast(null)} className="rounded p-1 text-success hover:bg-success/15" aria-label="Dismiss">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {view === 'all' ? (
        /* Every expense in this page's scope — the same browser as My Expenses */
        <ExpenseBrowser
          expenses={allExpenses}
          isLoading={allLoading}
          mode="review"
          onChanged={() => void qc.invalidateQueries({ queryKey: ['accountant-all'] })}
        />
      ) : (
      <>
      {/* Ready-for-Zoho card */}
      {activeLane === 'ready_for_zoho' && readyLaneCount > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-success/30 bg-success/10 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">
              {readyLaneCount.toLocaleString()} ready · {fmtMoney(readyTotal)}
            </p>
            {zohoLaneNote && <p className="mt-0.5 text-xs text-success">{zohoLaneNote}</p>}
          </div>
          <button
            type="button"
            onClick={() => bulkPushMutation.mutate(readyRows.map((e) => e.id))}
            disabled={bulkPushMutation.isPending || readyRows.length === 0}
            className="min-h-11 w-full cursor-pointer rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-cream hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:w-auto"
          >
            {bulkPushMutation.isPending
              ? 'Pushing…'
              : readyRows.length === readyLaneCount
                ? `Push ${readyRows.length} to Zoho${zohoPushSuffix}`
                : `Push ${readyRows.length} on this page${zohoPushSuffix}`}
          </button>
        </div>
      )}

      {/* Desktop: lane rail on the left, queue on the right. Phones keep the
          horizontal lane chips — the rail would eat the whole viewport there. */}
      <div className="flex items-start gap-6">
        <aside className="sticky top-4 hidden w-60 shrink-0 lg:block">
          <LaneRail activeLane={activeLane} laneCounts={laneCounts} onSelect={setActiveLane} />
        </aside>
        <div className="min-w-0 flex-1">

      {/* Queue lane tabs — grouped (phones/tablets only; the rail covers lg+) */}
      <div className="mb-4 space-y-2 lg:hidden">
        {/* Primary attention queues */}
        <LaneGroup
          label="Needs Attention"
          lanes={['needs_review', 'awaiting_user', 'zoho_failed']}
          activeLane={activeLane}
          laneCounts={laneCounts}
          onSelect={setActiveLane}
        />
        {/* Completion queues */}
        <LaneGroup
          label="Missing Fields"
          lanes={['missing_receipt', 'missing_category', 'missing_payment_method', 'missing_entity']}
          activeLane={activeLane}
          laneCounts={laneCounts}
          onSelect={setActiveLane}
        />
        {/* Ready / done */}
        <LaneGroup
          label="Ready & Processing"
          lanes={['ready_for_zoho', 'reimbursement_pending']}
          activeLane={activeLane}
          laneCounts={laneCounts}
          onSelect={setActiveLane}
        />
      </div>

      {/* Filter bar — search stays visible at every size; everything else
          collapses behind the Filters toggle so the queue stays above the fold. */}
      <div className="mb-4 rounded-xl border border-ink/10 bg-white p-3">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-charcoal/40" />
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search merchant or description…"
              className={`${filterInputClass} w-full pl-9`}
            />
          </div>
          <button
            type="button"
            onClick={() => setFiltersOpen((o) => !o)}
            aria-expanded={filtersOpen}
            className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-ink/15 px-3 py-1.5 text-sm font-medium text-charcoal/80 hover:bg-ink/[0.03] active:bg-ink/[0.03] md:min-h-0"
          >
            <SlidersHorizontal className="h-4 w-4" />
            Filters
            {activeFilterCount > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-500 px-1 text-xs font-semibold text-cream">
                {activeFilterCount}
              </span>
            )}
            <ChevronDown className={`h-4 w-4 text-charcoal/40 transition-transform ${filtersOpen ? 'rotate-180' : ''}`} />
          </button>
        </div>

        <div className={filtersOpen ? 'mt-3 border-t border-ink/5 pt-3' : 'hidden'}>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-3 lg:grid-cols-4">
          <select value={filters.userId} onChange={(e) => setFilter('userId', e.target.value)} className={filterSelectClass}>
            <option value="">All employees</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>{emp.name}</option>
            ))}
          </select>
          <select value={filters.company} onChange={(e) => setFilter('company', e.target.value)} className={filterSelectClass}>
            <option value="">Company: all</option>
            {companies.map((c) => (
              <option key={c.id} value={c.name}>{c.name}</option>
            ))}
          </select>
          <div className="relative z-10">
            <CategoryPicker
              categories={categories}
              value={filters.categoryId}
              onChange={(id) => setFilter('categoryId', id)}
              placeholder="All categories"
              emptyLabel="All categories"
              inputClassName={`${filterSelectClass} w-full`}
            />
          </div>
          <select value={filters.paymentMethodId} onChange={(e) => setFilter('paymentMethodId', e.target.value)} className={filterSelectClass}>
            <option value="">All payment methods</option>
            {paymentMethods.map((pm) => (
              <option key={pm.id} value={pm.id}>
                {pm.label}{pm.lastFour ? ` ···${pm.lastFour}` : ''}
              </option>
            ))}
          </select>
          <select value={filters.reimbursementStatus} onChange={(e) => setFilter('reimbursementStatus', e.target.value)} className={filterSelectClass}>
            <option value="">Reimbursement: any</option>
            {REIMBURSEMENT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <select value={filters.zohoStatus} onChange={(e) => setFilter('zohoStatus', e.target.value)} className={filterSelectClass}>
            <option value="">Zoho: any</option>
            <option value="synced">Synced</option>
            <option value="not_synced">Not synced</option>
            <option value="sync_failed">Sync failed</option>
          </select>
          {scope === 'event' && eventOptions.length > 0 && (
            <select value={filters.event} onChange={(e) => setFilter('event', e.target.value)} className={filterSelectClass}>
              <option value="">All events</option>
              {eventOptions.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          )}
          {sourceAppOptions.length > 1 && (
            <select value={filters.sourceApp} onChange={(e) => setFilter('sourceApp', e.target.value)} className={filterSelectClass}>
              <option value="">Source: any</option>
              {sourceAppOptions.map((app) => (
                <option key={app} value={app}>{humanizeSourceApp(app)}</option>
              ))}
            </select>
          )}
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={filters.from}
              onChange={(e) => setFilter('from', e.target.value)}
              className={`${filterInputClass} w-full`}
              aria-label="Date from"
            />
            <span className="text-xs text-charcoal/40">to</span>
            <input
              type="date"
              value={filters.to}
              onChange={(e) => setFilter('to', e.target.value)}
              className={`${filterInputClass} w-full`}
              aria-label="Date to"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min="0"
              step="0.01"
              value={filters.amountMin}
              onChange={(e) => setFilter('amountMin', e.target.value)}
              placeholder="Min $"
              className={`${filterInputClass} w-full`}
              aria-label="Amount minimum"
            />
            <span className="text-xs text-charcoal/40">–</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={filters.amountMax}
              onChange={(e) => setFilter('amountMax', e.target.value)}
              placeholder="Max $"
              className={`${filterInputClass} w-full`}
              aria-label="Amount maximum"
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <FilterChip
            label="OCR needs review"
            active={filters.ocrNeedsReview}
            onToggle={() => setFilter('ocrNeedsReview', !filters.ocrNeedsReview)}
          />
          <FilterChip
            label="Missing receipt"
            active={filters.missingReceipt}
            onToggle={() => setFilter('missingReceipt', !filters.missingReceipt)}
          />
          <FilterChip
            label="Missing category"
            active={filters.missingCategory}
            onToggle={() => setFilter('missingCategory', !filters.missingCategory)}
          />
          <FilterChip
            label="Missing payment"
            active={filters.missingPayment}
            onToggle={() => setFilter('missingPayment', !filters.missingPayment)}
          />
          {(hasActiveFilters || searchInput) && (
            <button
              onClick={clearFilters}
              className="ml-auto flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-muted hover:bg-brand-50 hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
              Clear filters
            </button>
          )}
        </div>
        </div>

        {/* Applied filters stay visible while the panel is collapsed */}
        {!filtersOpen && activeChips.length > 0 && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {activeChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={chip.clear}
                className="inline-flex items-center gap-1 rounded-full border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-800 hover:bg-brand-100"
              >
                {chip.label}
                <X className="h-3 w-3" />
              </button>
            ))}
            <button
              type="button"
              onClick={clearFilters}
              className="rounded-full px-2.5 py-1 text-xs font-medium text-muted hover:bg-brand-50 hover:text-ink"
            >
              Clear all
            </button>
          </div>
        )}
      </div>

      {/* Active lane heading */}
      <div className="mb-3">
        <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
          {LANES[activeLane].label}
          <span className="rounded-md bg-brand-50 px-2 py-0.5 text-xs font-semibold tabular-nums text-charcoal/80">
            {(laneCounts[activeLane] ?? 0).toLocaleString()}
          </span>
        </h2>
        <p className="mt-0.5 text-sm text-muted">
          {LANES[activeLane].description}
          {(activeLane === 'ready_for_zoho' || activeLane === 'zoho_failed') && zohoLaneNote
            ? ` ${zohoLaneNote}`
            : ''}
        </p>
      </div>

      {/* Bulk action bar */}
      {selectedRows.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3">
          <p className="text-sm font-medium text-ink">
            {selectedRows.length} selected · {fmtMoney(selectedTotal)}
          </p>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <button
              onClick={() => setShowApproveModal(true)}
              className="min-h-11 flex-1 rounded-lg bg-brand-600 px-3.5 py-1.5 text-sm font-semibold text-cream hover:bg-brand-700 sm:min-h-0 sm:flex-none"
            >
              Approve selected…
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="min-h-11 rounded-lg px-2.5 py-1.5 text-sm text-charcoal/70 hover:bg-white sm:min-h-0"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Expense table */}
      <div className="panel">
        {isLoading ? (
          <div className="px-6 py-12 text-center text-sm text-charcoal/40">Loading…</div>
        ) : displayData.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-charcoal/40">
            No items in this queue.
          </div>
        ) : (
          <>
          {/* Mobile: stacked cards */}
          <div className="divide-y divide-ink/5 md:hidden">
            {displayData.map((expense) => (
              <ExpenseCard
                key={expense.id}
                expense={expense}
                selected={selected.has(expense.id)}
                hideReadyFlag={activeLane === 'ready_for_zoho'}
                showEvent={scope === 'event'}
                onToggleSelect={() => toggleRow(expense.id)}
                onOpenReceipt={setQuickViewId}
                onReview={(action, note, requestType, internalNote) =>
                  reviewMutation.mutate({ id: expense.id, action, note, requestType, internalNote })
                }
                onResolve={() => resolveMutation.mutate(expense.id)}
                onPushZoho={() => zohoMutation.mutate(expense.id)}
                zohoPushSuffix={zohoPushSuffix}
                isActing={
                  reviewMutation.isPending ||
                  resolveMutation.isPending ||
                  zohoMutation.isPending
                }
              />
            ))}
          </div>
          {/* Desktop: full table */}
          <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink/10 bg-brand-50/80 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                <th className="w-10 px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={allOnPageSelected}
                    onChange={toggleAllOnPage}
                    className="h-4 w-4 rounded border-ink/15 text-brand-600 focus:ring-brand-500"
                    aria-label="Select all"
                  />
                </th>
                <th className="px-3 py-2.5">Merchant / Employee</th>
                {scope === 'event' && <th className="px-3 py-2.5">Event</th>}
                <th className="px-3 py-2.5">Date</th>
                <th className="px-3 py-2.5 text-right">Amount</th>
                {/* Flags live in this cell too — a separate Flags column pushed
                    the table past the viewport and is empty on most rows. */}
                <th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5">Receipt</th>
                <th className="px-3 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {displayData.map((expense) => (
                <ExpenseRow
                  key={expense.id}
                  expense={expense}
                  selected={selected.has(expense.id)}
                  hideReadyFlag={activeLane === 'ready_for_zoho'}
                  showEvent={scope === 'event'}
                  onToggleSelect={() => toggleRow(expense.id)}
                  onOpenReceipt={setQuickViewId}
                  onReview={(action, note, requestType, internalNote) =>
                    reviewMutation.mutate({ id: expense.id, action, note, requestType, internalNote })
                  }
                  onResolve={() => resolveMutation.mutate(expense.id)}
                  onPushZoho={() => zohoMutation.mutate(expense.id)}
                  zohoPushSuffix={zohoPushSuffix}
                  isActing={
                    reviewMutation.isPending ||
                    resolveMutation.isPending ||
                    zohoMutation.isPending
                  }
                />
              ))}
            </tbody>
          </table>
          </div>
          </>
        )}
      </div>

      {totalRows > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-charcoal/70">
          <p className="tabular-nums">
            {totalPages > 1
              ? `Showing ${pageFrom}–${pageTo} of ${totalRows.toLocaleString()}`
              : `${totalRows.toLocaleString()} expense${totalRows !== 1 ? 's' : ''}`}
          </p>
          {totalPages > 1 && (
            <div className="flex gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="min-h-11 cursor-pointer rounded-lg border border-ink/10 bg-white px-3 py-1.5 font-medium text-charcoal/80 hover:bg-ink/[0.03] disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="min-h-11 cursor-pointer rounded-lg border border-ink/10 bg-white px-3 py-1.5 font-medium text-charcoal/80 hover:bg-ink/[0.03] disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}

        </div>
      </div>
      </>
      )}

      {quickViewId && (
        <ExpenseQuickViewModal
          expenseId={quickViewId}
          onClose={() => setQuickViewId(null)}
          onDeleted={() => {
            void qc.invalidateQueries({ queryKey: ['accountant-queue'] });
            void qc.invalidateQueries({ queryKey: ['accountant-all'] });
          }}
        />
      )}

      {showApproveModal && (
        <BulkApproveModal
          rows={selectedRows}
          isPending={bulkApproveMutation.isPending}
          onCancel={() => setShowApproveModal(false)}
          onConfirm={(readyIds, flaggedCount) =>
            bulkApproveMutation.mutate({ ids: readyIds, flaggedCount })
          }
        />
      )}
    </div>
  );
}

// ── Bulk approve confirmation modal ───────────────────────────────────────────

function BulkApproveModal({
  rows,
  isPending,
  onCancel,
  onConfirm,
}: {
  rows: Expense[];
  isPending: boolean;
  onCancel: () => void;
  onConfirm: (readyIds: string[], flaggedCount: number) => void;
}) {
  const total = rows.reduce((sum, e) => sum + Number(e.amount || 0), 0);

  const missingReceipt = rows.filter((e) => (e.flags ?? []).includes('missing_receipt'));
  const missingCategory = rows.filter((e) => (e.flags ?? []).includes('needs_category'));
  const missingPayment = rows.filter((e) => (e.flags ?? []).includes('needs_payment_method'));
  const awaiting = rows.filter((e) => e.status === 'awaiting_info');

  const flaggedIds = new Set<string>();
  for (const list of [missingReceipt, missingCategory, missingPayment, awaiting]) {
    for (const e of list) flaggedIds.add(e.id);
  }
  const flaggedRows = rows.filter((e) => flaggedIds.has(e.id));
  const readyRows = rows.filter((e) => !flaggedIds.has(e.id));

  const breakdown: string[] = [];
  if (missingReceipt.length > 0) breakdown.push(`${missingReceipt.length} have missing receipts`);
  if (missingCategory.length > 0) breakdown.push(`${missingCategory.length} missing category`);
  if (missingPayment.length > 0) breakdown.push(`${missingPayment.length} missing payment method`);
  if (awaiting.length > 0) breakdown.push(`${awaiting.length} have unresolved issues`);

  return (
    <Modal
      open
      onClose={onCancel}
      size="sm"
      busy={isPending}
      dismissOnBackdrop={false}
      title={`Approve ${rows.length} expense${rows.length !== 1 ? 's' : ''}?`}
      subtitle={`Total selected: ${fmtMoney(total)}`}
      footer={
        <>
          <button onClick={onCancel} disabled={isPending} className="btn-secondary">
            Cancel
          </button>
          <button
            onClick={() => onConfirm(readyRows.map((e) => e.id), flaggedRows.length)}
            disabled={isPending || readyRows.length === 0}
            className="btn-primary"
          >
            {isPending
              ? 'Approving…'
              : `Approve ${readyRows.length} ready expense${readyRows.length !== 1 ? 's' : ''}`}
          </button>
        </>
      }
    >
      <div>
        {breakdown.length > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
            <p className="text-xs font-semibold text-amber-900">Flagged in this selection:</p>
            <ul className="mt-1 space-y-0.5">
              {breakdown.map((line) => (
                <li key={line} className="text-xs text-amber-800">• {line}</li>
              ))}
            </ul>
          </div>
        )}

        {flaggedRows.length > 0 && (
          <div className="mt-3">
            <p className="field-caption">Will be skipped</p>
            <ul className="mt-1.5 max-h-32 space-y-0.5 overflow-y-auto">
              {flaggedRows.map((e) => (
                <li key={e.id} className="text-xs text-charcoal/70">
                  • {e.merchant} — {fmtMoney(Number(e.amount || 0))}
                </li>
              ))}
            </ul>
          </div>
        )}

        {readyRows.length === 0 && (
          <p role="alert" className="mt-3 text-xs text-danger">
            Every selected expense is flagged — nothing to approve.
          </p>
        )}
      </div>
    </Modal>
  );
}

// ── Filter chip ───────────────────────────────────────────────────────────────

function FilterChip({ label, active, onToggle }: { label: string; active: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
        active
          ? 'border-brand-300 bg-brand-100 text-brand-800'
          : 'border-ink/10 bg-cream text-muted hover:bg-brand-50'
      }`}
    >
      {label}
    </button>
  );
}

// ── Lane group ────────────────────────────────────────────────────────────────

function LaneGroup({
  label,
  lanes,
  activeLane,
  laneCounts,
  onSelect,
}: {
  label: string;
  lanes: LaneId[];
  activeLane: LaneId;
  laneCounts: Partial<Record<LaneId, number>>;
  onSelect: (id: LaneId) => void;
}) {
  return (
    <div className="flex items-center gap-1 sm:flex-wrap">
      {/* Group label yields to lane chips on phones — the chips are self-explanatory */}
      <span className="mr-1 hidden text-xs font-semibold text-charcoal/40 shrink-0 sm:inline sm:w-28">{label}</span>
      <div className="flex min-w-0 gap-1 overflow-x-auto rounded-lg border border-ink/10 bg-brand-50 p-1 sm:flex-wrap sm:overflow-visible">
        {lanes.map((lane) => {
          const count = laneCounts[lane] ?? 0;
          return (
            <button
              key={lane}
              onClick={() => onSelect(lane)}
              className={`flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
                activeLane === lane
                  ? 'bg-white text-ink shadow-sm'
                  : 'text-charcoal/70 hover:text-ink'
              }`}
            >
              {LANES[lane].icon && <span className="opacity-60">{LANES[lane].icon}</span>}
              {LANES[lane].label}
              {count !== undefined && (
                <span className={`rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums ${countBadgeClass(lane, count, activeLane === lane)}`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Lane rail (desktop) ───────────────────────────────────────────────────────

const ATTENTION_LANES: LaneId[] = ['needs_review', 'awaiting_user', 'zoho_failed'];

function countBadgeClass(lane: LaneId, count: number, active: boolean): string {
  if (active) return 'bg-brand-100 text-brand-800';
  if (count === 0) return 'bg-brand-50 text-charcoal/40';
  if (ATTENTION_LANES.includes(lane)) return 'bg-amber-100 text-amber-800';
  if (lane === 'ready_for_zoho') return 'bg-success/10 text-success';
  return 'bg-brand-50 text-charcoal/70';
}
const RAIL_GROUPS: Array<{ label: string; lanes: LaneId[] }> = [
  { label: 'Needs Attention', lanes: ['needs_review', 'awaiting_user', 'zoho_failed'] },
  { label: 'Missing Fields', lanes: ['missing_receipt', 'missing_category', 'missing_payment_method', 'missing_entity'] },
  { label: 'Ready & Processing', lanes: ['ready_for_zoho', 'reimbursement_pending'] },
];

function LaneRail({
  activeLane,
  laneCounts,
  onSelect,
}: {
  activeLane: LaneId;
  laneCounts: Partial<Record<LaneId, number>>;
  onSelect: (id: LaneId) => void;
}) {
  return (
    <nav className="space-y-5 rounded-xl border border-ink/10 bg-white p-3">
      {RAIL_GROUPS.map((group) => (
        <div key={group.label}>
          <p className="px-2 text-[11px] font-semibold uppercase tracking-wider text-charcoal/40">{group.label}</p>
          <div className="mt-1.5 space-y-0.5">
            {group.lanes.map((lane) => {
              const count = laneCounts[lane] ?? 0;
              const active = activeLane === lane;
              return (
                <button
                  key={lane}
                  type="button"
                  onClick={() => onSelect(lane)}
                  className={`relative flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg py-2 pl-3 pr-2.5 text-left text-sm transition-colors ${
                    active
                      ? 'bg-brand-50 font-semibold text-brand-800 before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-full before:bg-gold-400'
                      : 'font-medium text-charcoal/70 hover:bg-ink/[0.03] hover:text-ink'
                  }`}
                >
                  <span className="flex min-w-0 items-start gap-2">
                    {LANES[lane].icon && (
                      <span className={`mt-0.5 ${active ? 'text-brand-600' : 'text-charcoal/40'}`}>{LANES[lane].icon}</span>
                    )}
                    <span className="leading-snug">{LANES[lane].label}</span>
                  </span>
                  {count !== undefined && (
                    <span
                      className={`shrink-0 rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums ${countBadgeClass(lane, count, active)}`}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

// ── Flag badge ────────────────────────────────────────────────────────────────

function FlagBadge({ flag }: { flag: string }) {
  const meta = FLAG_META[flag];
  if (!meta) return null;
  return (
    <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${meta.color}`}>
      {meta.label}
    </span>
  );
}

// ── OCR badge (accountant-only; shown in flags column alongside expense flags) ─

function OcrQueueBadge({ receipts }: { receipts: Array<{ ocrStatus: string; ocrNeedsReview?: boolean | null }> }) {
  if (!receipts.length) return null;
  const hasFailed = receipts.some((r) => r.ocrStatus === 'failed');
  const needsReview = receipts.some((r) => r.ocrNeedsReview === true);
  if (hasFailed) {
    return (
      <span className="inline-flex rounded px-1.5 py-0.5 text-xs font-medium bg-danger/15 text-danger">
        OCR failed
      </span>
    );
  }
  if (needsReview) {
    return (
      <span className="inline-flex rounded px-1.5 py-0.5 text-xs font-medium bg-amber-100 text-amber-700">
        OCR: needs review
      </span>
    );
  }
  return null;
}

// ── Expense row ───────────────────────────────────────────────────────────────

const REQUEST_TYPE_OPTIONS = [
  { value: 'info_request', label: 'General question' },
  { value: 'missing_receipt', label: 'Please upload receipt' },
  { value: 'missing_category', label: 'Please select category' },
  { value: 'missing_payment_method', label: 'Please specify payment method' },
];

interface ExpenseRowProps {
  expense: Expense;
  selected: boolean;
  hideReadyFlag?: boolean;
  /** Event Review only — the daily page has no events to show. */
  showEvent?: boolean;
  onToggleSelect: () => void;
  onOpenReceipt: (expenseId: string) => void;
  onReview: (action: 'approve' | 'reject' | 'request_info', note?: string, requestType?: string, internalNote?: string) => void;
  onResolve: () => void;
  onPushZoho: () => void;
  zohoPushSuffix: string;
  isActing: boolean;
}

/** Status/flag facts the desktop row and mobile card both branch on — keep in one place. */
function deriveRowState(expense: Expense, hideReadyFlag = false) {
  return {
    flags: (expense.flags ?? []).filter((f) =>
      f !== 'zoho_synced'
      && f !== 'from_extension'
      && !(hideReadyFlag && f === 'ready_for_zoho')
    ),
    isFromExtension: (expense.flags ?? []).includes('from_extension'),
    canReview: expense.status === 'pending' || expense.status === 'in_review',
    isAwaiting: expense.status === 'awaiting_info',
    isReadyForZoho: (expense.flags ?? []).includes('ready_for_zoho'),
    isZohoFailed: expense.status === 'zoho_sync_failed',
    needsReimb:
      expense.reimbursementStatus === 'pending' || expense.reimbursementStatus === 'approved',
  };
}

/** "Needs review" request form — shared by the desktop row and the mobile card. */
function AskForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (note: string, requestType: string, internalNote?: string) => void;
  onCancel: () => void;
}) {
  const [askNote, setAskNote] = useState('');
  const [askType, setAskType] = useState('info_request');
  const [askInternal, setAskInternal] = useState('');

  function submitAsk() {
    if (!askNote.trim()) return;
    onSubmit(askNote.trim(), askType, askInternal.trim() || undefined);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <select
          value={askType}
          onChange={(e) => setAskType(e.target.value)}
          className="min-h-11 rounded-lg border border-brand-300 bg-white px-2 py-1.5 text-sm focus:outline-none sm:min-h-0"
        >
          {REQUEST_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <input
          autoFocus
          value={askNote}
          onChange={(e) => setAskNote(e.target.value)}
          placeholder="Message to employee…"
          className="min-h-11 flex-1 rounded-lg border border-brand-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 sm:min-h-0"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={askInternal}
          onChange={(e) => setAskInternal(e.target.value)}
          placeholder="Internal note (not shown to employee, optional)"
          className="min-h-11 min-w-0 flex-1 basis-40 rounded-lg border border-ink/15 bg-cream px-3 py-1.5 text-xs text-charcoal/70 focus:outline-none focus:ring-1 focus:ring-brand-500 sm:min-h-0"
        />
        <button
          onClick={submitAsk}
          disabled={!askNote.trim()}
          className="flex min-h-11 items-center gap-1 rounded-lg bg-brand-500 px-3 py-1.5 text-sm text-cream hover:bg-brand-600 disabled:opacity-50 sm:min-h-0"
        >
          <Send className="h-3.5 w-3.5" />
          Send
        </button>
        <button
          onClick={onCancel}
          className="min-h-11 text-sm text-muted hover:text-ink sm:min-h-0"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ExpenseRow({
  expense,
  selected,
  hideReadyFlag,
  showEvent,
  onToggleSelect,
  onOpenReceipt,
  onReview,
  onResolve,
  onPushZoho,
  zohoPushSuffix,
  isActing,
}: ExpenseRowProps) {
  const [showAskForm, setShowAskForm] = useState(false);

  const { flags, isFromExtension, canReview, isAwaiting, isReadyForZoho, isZohoFailed, needsReimb } =
    deriveRowState(expense, hideReadyFlag);

  return (
    <>
      <tr className={selected ? 'bg-brand-50/50' : 'hover:bg-ink/[0.03]'}>
        <td className="w-10 px-3 py-2.5">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            className="h-4 w-4 rounded border-ink/15 text-brand-600 focus:ring-brand-500"
            aria-label={`Select ${expense.merchant}`}
          />
        </td>
        <td className="px-3 py-2.5">
          <Link to={`/accountant/${expense.id}`} className="font-medium text-ink hover:text-brand-700">
            {expense.merchant}
          </Link>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <span>{expense.user?.name ?? '—'}</span>
            {isFromExtension && (
              <span className="rounded bg-brand-100 px-1 py-0.5 text-brand-700">Extension</span>
            )}
            {expense.category && (
              <span>· {expense.category.name}</span>
            )}
            {expense.paymentMethod && (
              <span>
                · {expense.paymentMethod.label}{expense.paymentMethod.lastFour ? ` ···${expense.paymentMethod.lastFour}` : ''}
              </span>
            )}
          </div>
        </td>
        {showEvent && (
          <td className="min-w-32 max-w-56 px-3 py-2.5">
            {expense.sourceLabel ? (
              // Wraps rather than truncating — an event name the accountant
              // cannot finish reading defeats the point of the column.
              <span className="break-words text-charcoal/80">{expense.sourceLabel}</span>
            ) : (
              <span className="text-muted">—</span>
            )}
          </td>
        )}
        <td className="whitespace-nowrap px-3 py-2.5 text-charcoal/70 tabular-nums">{expense.date}</td>
        <td className="whitespace-nowrap px-3 py-2.5 text-right font-medium tabular-nums text-ink">
          {expense.currency} {Number(expense.amount).toFixed(2)}
        </td>
        <td className="px-3 py-2.5">
          <div className="flex flex-col items-start gap-1">
            <StatusBadge status={expense.status} variant="accountant" />
            <ZohoPushBadge
              zohoExpenseId={expense.zohoExpenseId}
              syncFailed={isZohoFailed}
            />
            {isZohoFailed && <ZohoErrorCategoryChip error={expense.zohoSyncError} />}
            {needsReimb && <ReimbursementBadge status={expense.reimbursementStatus} />}
            {(flags.length > 0 || (expense.receipts?.length ?? 0) > 0) && (
              <div className="flex flex-wrap items-center gap-1">
                {flags.map((f) => <FlagBadge key={f} flag={f} />)}
                <OcrQueueBadge receipts={expense.receipts ?? []} />
              </div>
            )}
          </div>
        </td>
        <td className="px-3 py-2.5">
          <ReceiptDetailsButton
            expenseId={expense.id}
            receipts={expense.receipts}
            onOpen={onOpenReceipt}
          />
        </td>
        <td className="px-3 py-2.5">
          <RowActions
            canReview={canReview}
            isAwaiting={isAwaiting}
            isReadyForZoho={isReadyForZoho}
            isZohoFailed={isZohoFailed}
            zohoPushSuffix={zohoPushSuffix}
            isActing={isActing}
            onApprove={() => onReview('approve')}
            onReject={() => onReview('reject')}
            onAsk={() => setShowAskForm(true)}
            onResolve={onResolve}
            onPushZoho={onPushZoho}
          />
        </td>
      </tr>

      {showAskForm && (
        <tr className="bg-brand-50">
          <td colSpan={showEvent ? 8 : 7} className="px-3 py-3">
            <AskForm
              onSubmit={(note, requestType, internalNote) => {
                onReview('request_info', note, requestType, internalNote);
                setShowAskForm(false);
              }}
              onCancel={() => setShowAskForm(false)}
            />
          </td>
        </tr>
      )}
    </>
  );
}

// ── Expense card (mobile) ─────────────────────────────────────────────────────

function ExpenseCard({
  expense,
  selected,
  hideReadyFlag,
  showEvent,
  onToggleSelect,
  onOpenReceipt,
  onReview,
  onResolve,
  onPushZoho,
  zohoPushSuffix,
  isActing,
}: ExpenseRowProps) {
  const [showAskForm, setShowAskForm] = useState(false);

  const { flags, isFromExtension, canReview, isAwaiting, isReadyForZoho, isZohoFailed, needsReimb } =
    deriveRowState(expense, hideReadyFlag);

  return (
    <div className={`px-4 py-3 ${selected ? 'bg-brand-50/50' : ''}`}>
      <div className="flex items-start gap-1">
        {/* Checkbox sits outside the Link so tapping it never navigates */}
        <label className="-my-2 -ml-2 flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            className="h-4 w-4 rounded border-ink/15 text-brand-600 focus:ring-brand-500"
            aria-label={`Select ${expense.merchant}`}
          />
        </label>
        <Link to={`/accountant/${expense.id}`} className="block min-w-0 flex-1 active:bg-ink/[0.03]">
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 truncate font-medium text-ink">{expense.merchant}</p>
            <p className="shrink-0 font-medium text-ink">
              {expense.currency} {Number(expense.amount).toFixed(2)}
            </p>
          </div>
          {showEvent && (
            <div className="mt-1 flex">
              <ExpenseTypeChip expense={expense} />
            </div>
          )}
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted">{expense.date}</span>
            <span className="text-xs text-charcoal/40">· {expense.user?.name ?? '—'}</span>
            {isFromExtension && (
              <span className="rounded bg-brand-100 px-1 py-0.5 text-xs text-brand-700">Extension</span>
            )}
            {expense.category && (
              <span className="text-xs text-charcoal/40">· {expense.category.name}</span>
            )}
            {expense.paymentMethod && (
              <span className="text-xs text-charcoal/40">
                · {expense.paymentMethod.label}{expense.paymentMethod.lastFour ? ` ···${expense.paymentMethod.lastFour}` : ''}
              </span>
            )}
          </div>
        </Link>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <StatusBadge status={expense.status} variant="accountant" />
        <ZohoPushBadge
          zohoExpenseId={expense.zohoExpenseId}
          syncFailed={isZohoFailed}
        />
        {isZohoFailed && <ZohoErrorCategoryChip error={expense.zohoSyncError} />}
        {needsReimb && <ReimbursementBadge status={expense.reimbursementStatus} />}
        {flags.map((f) => <FlagBadge key={f} flag={f} />)}
        <OcrQueueBadge receipts={expense.receipts ?? []} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <ReceiptDetailsButton
          expenseId={expense.id}
          receipts={expense.receipts}
          onOpen={onOpenReceipt}
        />
        <RowActions
          touch
          canReview={canReview}
          isAwaiting={isAwaiting}
          isReadyForZoho={isReadyForZoho}
          isZohoFailed={isZohoFailed}
          zohoPushSuffix={zohoPushSuffix}
          isActing={isActing}
          onApprove={() => onReview('approve')}
          onReject={() => onReview('reject')}
          onAsk={() => setShowAskForm(true)}
          onResolve={onResolve}
          onPushZoho={onPushZoho}
        />
      </div>
      {showAskForm && (
        <div className="mt-2 rounded-lg bg-brand-50 p-3">
          <AskForm
            onSubmit={(note, requestType, internalNote) => {
              onReview('request_info', note, requestType, internalNote);
              setShowAskForm(false);
            }}
            onCancel={() => setShowAskForm(false)}
          />
        </div>
      )}
    </div>
  );
}

// ── Action button ─────────────────────────────────────────────────────────────

function RowActions({
  touch = false,
  canReview,
  isAwaiting,
  isReadyForZoho,
  isZohoFailed,
  zohoPushSuffix,
  isActing,
  onApprove,
  onReject,
  onAsk,
  onResolve,
  onPushZoho,
}: {
  touch?: boolean;
  canReview: boolean;
  isAwaiting: boolean;
  isReadyForZoho: boolean;
  isZohoFailed: boolean;
  zohoPushSuffix: string;
  isActing: boolean;
  onApprove: () => void;
  onReject: () => void;
  onAsk: () => void;
  onResolve: () => void;
  onPushZoho: () => void;
}) {
  if (!canReview && !isAwaiting && !isReadyForZoho && !isZohoFailed) {
    return <span className="text-xs text-charcoal/40">—</span>;
  }

  return (
    <div className={`flex items-center gap-1.5 ${touch ? 'flex-wrap' : 'whitespace-nowrap'}`}>
      {canReview && (
        <>
          <ActionBtn color="green" size={touch ? 'touch' : 'xs'} onClick={onApprove} disabled={isActing}>
            Approve
          </ActionBtn>
          <ActionBtn color="red" size={touch ? 'touch' : 'xs'} onClick={onReject} disabled={isActing}>
            Reject
          </ActionBtn>
          {/* "Ask" on desktop — matches the review screen's action and keeps
              the row inside the viewport; the mobile card has room to wrap. */}
          <ActionBtn color="blue" size={touch ? 'touch' : 'xs'} onClick={onAsk} disabled={isActing}>
            {touch ? 'Needs review' : 'Ask'}
          </ActionBtn>
        </>
      )}
      {isAwaiting && (
        <ActionBtn color="blue" size={touch ? 'touch' : 'xs'} onClick={onResolve} disabled={isActing}>
          Resolve
        </ActionBtn>
      )}
      {(isReadyForZoho || isZohoFailed) && (
        <ActionBtn color="teal" size={touch ? 'touch' : 'xs'} onClick={onPushZoho} disabled={isActing}>
          {isZohoFailed ? `Retry Zoho${zohoPushSuffix}` : `Push to Zoho${zohoPushSuffix}`}
        </ActionBtn>
      )}
    </div>
  );
}

function ActionBtn({
  color, onClick, children, disabled, size = 'xs',
}: { color: 'green' | 'red' | 'blue' | 'teal' | 'gray'; onClick: () => void; children: React.ReactNode; disabled?: boolean; size?: 'xs' | 'touch' }) {
  const styles = {
    green: 'border-transparent bg-success text-cream hover:opacity-90',
    red: 'border-danger/30 bg-white text-danger hover:bg-danger/10',
    blue: 'border-ink/15 bg-white text-charcoal/80 hover:bg-ink/[0.03]',
    teal: 'border-transparent bg-brand-500 text-cream hover:bg-brand-600',
    gray: 'border-ink/10 bg-cream text-muted hover:bg-brand-50',
  };
  const sizes = {
    xs: 'px-2.5 py-1 text-xs',
    touch: 'min-h-11 px-3.5 py-1.5 text-xs',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`cursor-pointer rounded-md border font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${sizes[size]} ${styles[color]}`}
    >
      {children}
    </button>
  );
}
