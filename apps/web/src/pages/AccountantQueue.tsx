import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Clock, RefreshCw, XCircle, Send, FileX, Tag, CreditCard, Building2, Banknote, Eye } from 'lucide-react';
import { accountantApi } from '../api/expenses';
import { StatusBadge } from '../components/StatusBadge';
import { ReceiptDetailsButton } from '../components/ReceiptDetailsButton';
import { useAuth } from '../contexts/AuthContext';
import type { Expense } from '../types';

// ── Lane definitions ──────────────────────────────────────────────────────────

type LaneId =
  | 'needs_review'
  | 'in_review'
  | 'awaiting_user'
  | 'missing_receipt'
  | 'missing_category'
  | 'missing_payment_method'
  | 'missing_entity'
  | 'ready_for_zoho'
  | 'zoho_failed'
  | 'reimbursement_pending'
  | 'all';

interface LaneDef {
  label: string;
  icon: React.ReactNode;
  description: string;
  filter: (e: Expense) => boolean;
}

const LANES: Record<LaneId, LaneDef> = {
  needs_review: {
    label: 'Needs Review',
    icon: <Clock className="h-3.5 w-3.5" />,
    description: 'New submissions waiting for first review — not yet claimed by an accountant',
    filter: (e) => e.status === 'pending',
  },
  in_review: {
    label: 'In Review',
    icon: <Eye className="h-3.5 w-3.5" />,
    description: 'Claimed by an accountant — actively being reviewed',
    filter: (e) => e.status === 'in_review',
  },
  awaiting_user: {
    label: 'Awaiting User',
    icon: <AlertCircle className="h-3.5 w-3.5" />,
    description: 'You asked for more information — waiting on employee response',
    filter: (e) => e.status === 'awaiting_info',
  },
  missing_receipt: {
    label: 'Missing Receipt',
    icon: <FileX className="h-3.5 w-3.5" />,
    description: 'Approved expenses without a receipt attached',
    filter: (e) => e.status === 'approved' && (e.flags ?? []).includes('missing_receipt'),
  },
  missing_category: {
    label: 'Missing Category',
    icon: <Tag className="h-3.5 w-3.5" />,
    description: 'Approved expenses without a category — cannot push to Zoho',
    filter: (e) => e.status === 'approved' && (e.flags ?? []).includes('needs_category'),
  },
  missing_payment_method: {
    label: 'Missing Payment',
    icon: <CreditCard className="h-3.5 w-3.5" />,
    description: 'Approved expenses without a payment method — required for Zoho',
    filter: (e) => e.status === 'approved' && (e.flags ?? []).includes('needs_payment_method'),
  },
  missing_entity: {
    label: 'Missing Entity',
    icon: <Building2 className="h-3.5 w-3.5" />,
    description: 'Approved but Zoho accounting entity not set',
    filter: (e) => e.status === 'approved' && (e.flags ?? []).includes('needs_entity'),
  },
  ready_for_zoho: {
    label: 'Ready for Zoho',
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
    description: 'All required fields complete — ready to push to Zoho. Zoho is in mock mode: no real sync will occur.',
    filter: (e) => (e.flags ?? []).includes('ready_for_zoho'),
  },
  zoho_failed: {
    label: 'Zoho Failed',
    icon: <RefreshCw className="h-3.5 w-3.5" />,
    description: 'Zoho sync failed — needs retry. Zoho is in mock mode during this pilot.',
    filter: (e) => e.status === 'zoho_sync_failed',
  },
  reimbursement_pending: {
    label: 'Reimbursement',
    icon: <Banknote className="h-3.5 w-3.5" />,
    description: 'Employees waiting to be reimbursed',
    filter: (e) => (e.flags ?? []).includes('reimbursement_pending'),
  },
  all: {
    label: 'All Expenses',
    icon: null,
    description: 'Every expense in the system',
    filter: () => true,
  },
};

// Flag metadata for inline badges
const FLAG_META: Record<string, { label: string; color: string }> = {
  needs_category: { label: 'No Category', color: 'bg-orange-100 text-orange-700' },
  missing_receipt: { label: 'No Receipt', color: 'bg-red-100 text-red-700' },
  needs_payment_method: { label: 'No Payment', color: 'bg-purple-100 text-purple-700' },
  needs_entity: { label: 'No Entity', color: 'bg-indigo-100 text-indigo-700' },
  ready_for_zoho: { label: 'Ready for Zoho', color: 'bg-teal-100 text-teal-700' },
  from_extension: { label: 'Extension', color: 'bg-blue-100 text-blue-700' },
  zoho_synced: { label: 'Synced', color: 'bg-green-100 text-green-700' },
  reimbursement_pending: { label: 'Reimb. Pending', color: 'bg-orange-100 text-orange-700' },
};

// ── Main component ────────────────────────────────────────────────────────────

export function AccountantQueue() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [activeLane, setActiveLane] = useState<LaneId>('needs_review');

  const { data: queue = [], isLoading: queueLoading } = useQuery({
    queryKey: ['accountant-queue'],
    queryFn: () => accountantApi.queue(),
  });

  const { data: allExpenses = [], isLoading: allLoading } = useQuery({
    queryKey: ['accountant-all'],
    queryFn: () => accountantApi.all(),
    enabled: activeLane === 'all',
  });

  const reviewMutation = useMutation({
    mutationFn: ({ id, action, note, requestType, internalNote }: {
      id: string;
      action: 'approve' | 'reject' | 'request_info';
      note?: string;
      requestType?: string;
      internalNote?: string;
    }) => accountantApi.review(id, { action, note, requestType, internalNote }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accountant-queue'] });
      qc.invalidateQueries({ queryKey: ['accountant-all'] });
    },
  });

  const claimMutation = useMutation({
    mutationFn: (id: string) => accountantApi.claim(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accountant-queue'] });
      qc.invalidateQueries({ queryKey: ['accountant-all'] });
    },
  });

  const releaseClaimMutation = useMutation({
    mutationFn: (id: string) => accountantApi.releaseClaim(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accountant-queue'] });
      qc.invalidateQueries({ queryKey: ['accountant-all'] });
    },
  });

  const resolveMutation = useMutation({
    mutationFn: (id: string) => accountantApi.resolveRequest(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accountant-queue'] });
      qc.invalidateQueries({ queryKey: ['accountant-all'] });
    },
  });

  const zohoMutation = useMutation({
    mutationFn: (id: string) => accountantApi.pushToZoho(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accountant-queue'] });
      qc.invalidateQueries({ queryKey: ['accountant-all'] });
    },
  });

  // Derive lane counts from queue data (no extra requests)
  const laneCounts: Partial<Record<LaneId, number>> = {};
  const sourceData = activeLane === 'all' ? allExpenses : queue;
  for (const laneId of Object.keys(LANES) as LaneId[]) {
    if (laneId === 'all') continue;
    laneCounts[laneId] = queue.filter(LANES[laneId].filter).length;
  }
  const totalActive = queue.filter((e) => e.status !== 'approved' || (e.flags ?? []).includes('ready_for_zoho')).length;

  const displayData = activeLane === 'all'
    ? allExpenses
    : queue.filter(LANES[activeLane].filter);

  const isLoading = activeLane === 'all' ? allLoading : queueLoading;

  // Summary cards — the 4 most actionable queues
  const summaryLanes: { id: LaneId; color: string }[] = [
    { id: 'needs_review', color: 'yellow' },
    { id: 'in_review', color: 'blue' },
    { id: 'awaiting_user', color: 'amber' },
    { id: 'ready_for_zoho', color: 'teal' },
  ];

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Accountant Workspace</h1>
        <p className="mt-1 text-sm text-gray-500">
          {totalActive > 0
            ? `${totalActive} item${totalActive !== 1 ? 's' : ''} need attention`
            : 'All queues clear — nothing urgent.'}
        </p>
      </div>

      {/* Summary stat cards */}
      <div className="mb-6 grid grid-cols-4 gap-3">
        {summaryLanes.map(({ id, color }) => (
          <SummaryCard
            key={id}
            label={LANES[id].label}
            count={laneCounts[id] ?? 0}
            color={color}
            onClick={() => setActiveLane(id)}
            active={activeLane === id}
          />
        ))}
      </div>

      {/* Queue lane tabs — grouped */}
      <div className="mb-4 space-y-2">
        {/* Primary attention queues */}
        <LaneGroup
          label="Needs Attention"
          lanes={['needs_review', 'in_review', 'awaiting_user', 'zoho_failed']}
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
          lanes={['ready_for_zoho', 'reimbursement_pending', 'all']}
          activeLane={activeLane}
          laneCounts={laneCounts}
          onSelect={setActiveLane}
        />
      </div>

      {/* Lane description */}
      {activeLane !== 'all' && (
        <p className="mb-3 text-xs text-gray-400">{LANES[activeLane].description}</p>
      )}

      {/* Expense table */}
      <div className="rounded-xl border border-gray-200 bg-white">
        {isLoading ? (
          <div className="px-6 py-12 text-center text-sm text-gray-400">Loading…</div>
        ) : displayData.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-gray-400">
            {activeLane === 'all' ? 'No expenses yet.' : `No items in this queue.`}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                <th className="px-5 py-3">Merchant / Employee</th>
                <th className="px-5 py-3">Date</th>
                <th className="px-5 py-3 text-right">Amount</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Receipt</th>
                <th className="px-5 py-3">Flags</th>
                <th className="px-5 py-3">Quick Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {displayData.map((expense) => (
                <ExpenseRow
                  key={expense.id}
                  expense={expense}
                  activeLane={activeLane}
                  currentUserId={user?.id}
                  currentUserRole={user?.role}
                  onClaim={() => claimMutation.mutate(expense.id)}
                  onReleaseClaim={() => releaseClaimMutation.mutate(expense.id)}
                  onReview={(action, note, requestType, internalNote) =>
                    reviewMutation.mutate({ id: expense.id, action, note, requestType, internalNote })
                  }
                  onResolve={() => resolveMutation.mutate(expense.id)}
                  onPushZoho={() => zohoMutation.mutate(expense.id)}
                  isActing={
                    claimMutation.isPending ||
                    releaseClaimMutation.isPending ||
                    reviewMutation.isPending ||
                    resolveMutation.isPending ||
                    zohoMutation.isPending
                  }
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
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
    <div className="flex items-center gap-1 flex-wrap">
      <span className="mr-1 text-xs font-semibold text-gray-400 w-28 shrink-0">{label}</span>
      <div className="flex gap-1 rounded-lg border border-gray-200 bg-gray-100 p-1 flex-wrap">
        {lanes.map((lane) => {
          const count = lane === 'all' ? undefined : (laneCounts[lane] ?? 0);
          const urgent = count !== undefined && count > 0;
          return (
            <button
              key={lane}
              onClick={() => onSelect(lane)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
                activeLane === lane
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              {LANES[lane].icon && <span className="opacity-60">{LANES[lane].icon}</span>}
              {LANES[lane].label}
              {count !== undefined && (
                <span className={`rounded-full px-1.5 py-0.5 text-xs ${
                  activeLane === lane
                    ? 'bg-brand-100 text-brand-700'
                    : urgent
                    ? 'bg-yellow-200 text-yellow-800'
                    : 'bg-gray-200 text-gray-500'
                }`}>
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

// ── Summary card ──────────────────────────────────────────────────────────────

function SummaryCard({
  label, count, color, onClick, active,
}: { label: string; count: number; color: string; onClick: () => void; active: boolean }) {
  const colorMap: Record<string, string> = {
    yellow: 'border-yellow-200 bg-yellow-50 text-yellow-800 hover:bg-yellow-100',
    amber: 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100',
    blue: 'border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100',
    red: 'border-red-200 bg-red-50 text-red-800 hover:bg-red-100',
    teal: 'border-teal-200 bg-teal-50 text-teal-800 hover:bg-teal-100',
  };
  return (
    <button
      onClick={onClick}
      className={`rounded-xl border-2 p-4 text-left cursor-pointer transition-colors w-full ${colorMap[color] ?? colorMap.yellow} ${active ? 'ring-2 ring-offset-1 ring-current' : ''}`}
    >
      <p className="text-xs font-medium opacity-80">{label}</p>
      <p className="mt-1 text-2xl font-bold">{count}</p>
    </button>
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
      <span className="inline-flex rounded px-1.5 py-0.5 text-xs font-medium bg-red-100 text-red-700">
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

function ExpenseRow({
  expense,
  activeLane,
  currentUserId,
  currentUserRole,
  onClaim,
  onReleaseClaim,
  onReview,
  onResolve,
  onPushZoho,
  isActing,
}: {
  expense: Expense;
  activeLane: LaneId;
  currentUserId: string | undefined;
  currentUserRole: string | undefined;
  onClaim: () => void;
  onReleaseClaim: () => void;
  onReview: (action: 'approve' | 'reject' | 'request_info', note?: string, requestType?: string, internalNote?: string) => void;
  onResolve: () => void;
  onPushZoho: () => void;
  isActing: boolean;
}) {
  const [showAskForm, setShowAskForm] = useState(false);
  const [askNote, setAskNote] = useState('');
  const [askType, setAskType] = useState('info_request');
  const [askInternal, setAskInternal] = useState('');

  const flags = (expense.flags ?? []).filter((f) => f !== 'zoho_synced' && f !== 'from_extension');
  const isFromExtension = (expense.flags ?? []).includes('from_extension');
  const isPending = expense.status === 'pending';
  const isInReview = expense.status === 'in_review';
  const isAwaiting = expense.status === 'awaiting_info';

  // Ownership: full Approve/Reject/Ask only for the claiming reviewer or admin.
  // Any accountant can still release or act if no one has claimed it yet.
  const isClaimer = expense.reviewedById === currentUserId;
  const isAdmin = currentUserRole === 'admin';
  const canAct = isInReview && (isClaimer || isAdmin || !expense.reviewedById);
  const isReadyForZoho = (expense.flags ?? []).includes('ready_for_zoho');
  const isZohoFailed = expense.status === 'zoho_sync_failed';

  function submitAsk() {
    if (!askNote.trim()) return;
    onReview('request_info', askNote.trim(), askType, askInternal.trim() || undefined);
    setShowAskForm(false);
    setAskNote('');
    setAskType('info_request');
    setAskInternal('');
  }

  return (
    <>
      <tr className="hover:bg-gray-50">
        <td className="px-5 py-3">
          <Link to={`/expenses/${expense.id}`} className="font-medium text-gray-900 hover:text-brand-700">
            {expense.merchant}
          </Link>
          <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-gray-400">{expense.user?.name ?? '—'}</span>
            {isFromExtension && (
              <span className="rounded bg-blue-100 px-1 py-0.5 text-xs text-blue-700">Extension</span>
            )}
            {expense.category && (
              <span className="text-xs text-gray-400">· {expense.category.name}</span>
            )}
            {expense.paymentMethod && (
              <span className="text-xs text-gray-400">
                · {expense.paymentMethod.label}{expense.paymentMethod.lastFour ? ` ···${expense.paymentMethod.lastFour}` : ''}
              </span>
            )}
            {expense.status === 'in_review' && expense.reviewedBy && (
              <span className="inline-flex items-center gap-0.5 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-600">
                <Eye className="h-3 w-3" />
                {expense.reviewedBy.name}
              </span>
            )}
          </div>
        </td>
        <td className="px-5 py-3 text-gray-600">{expense.date}</td>
        <td className="px-5 py-3 text-right font-medium text-gray-900">
          {expense.currency} {Number(expense.amount).toFixed(2)}
        </td>
        <td className="px-5 py-3">
          <StatusBadge status={expense.status} variant="accountant" />
        </td>
        <td className="px-5 py-3">
          <ReceiptDetailsButton expenseId={expense.id} receipts={expense.receipts} />
        </td>
        <td className="px-5 py-3">
          <div className="flex flex-wrap items-center gap-1">
            {flags.map((f) => <FlagBadge key={f} flag={f} />)}
            <OcrQueueBadge receipts={expense.receipts ?? []} />
          </div>
        </td>
        <td className="px-5 py-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            {isPending && (
              <ActionBtn color="blue" onClick={onClaim} disabled={isActing}>
                Mark as Reviewing
              </ActionBtn>
            )}
            {isInReview && canAct && (
              <>
                <ActionBtn color="green" onClick={() => onReview('approve')} disabled={isActing}>Approve</ActionBtn>
                <ActionBtn color="red" onClick={() => onReview('reject')} disabled={isActing}>Reject</ActionBtn>
                <ActionBtn color="blue" onClick={() => setShowAskForm(true)} disabled={isActing}>Ask</ActionBtn>
              </>
            )}
            {isInReview && !canAct && (
              <span className="text-xs text-gray-400 italic">
                Claimed by {expense.reviewedBy?.name ?? 'another accountant'}
              </span>
            )}
            {isInReview && (
              <ActionBtn color="gray" onClick={onReleaseClaim} disabled={isActing}>
                Release
              </ActionBtn>
            )}
            {isAwaiting && (
              <ActionBtn color="blue" onClick={onResolve} disabled={isActing}>Resolve</ActionBtn>
            )}
            {(isReadyForZoho || isZohoFailed) && (
              <ActionBtn color="teal" onClick={onPushZoho} disabled={isActing}>
                {isZohoFailed ? 'Retry Zoho [mock]' : 'Push to Zoho [mock]'}
              </ActionBtn>
            )}
            {!isPending && !isInReview && !isAwaiting && !isReadyForZoho && !isZohoFailed && (
              <span className="text-xs text-gray-400">—</span>
            )}
          </div>
        </td>
      </tr>

      {showAskForm && (
        <tr className="bg-blue-50">
          <td colSpan={6} className="px-5 py-3">
            <div className="space-y-2">
              <div className="flex items-start gap-2">
                <select
                  value={askType}
                  onChange={(e) => setAskType(e.target.value)}
                  className="rounded-lg border border-blue-300 bg-white px-2 py-1.5 text-sm focus:outline-none"
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
                  className="flex-1 rounded-lg border border-blue-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  value={askInternal}
                  onChange={(e) => setAskInternal(e.target.value)}
                  placeholder="Internal note (not shown to employee, optional)"
                  className="flex-1 rounded-lg border border-gray-300 bg-gray-50 px-3 py-1.5 text-xs text-gray-600 focus:outline-none focus:ring-1 focus:ring-gray-400"
                />
                <button
                  onClick={submitAsk}
                  disabled={!askNote.trim()}
                  className="flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  <Send className="h-3.5 w-3.5" />
                  Send
                </button>
                <button
                  onClick={() => { setShowAskForm(false); setAskNote(''); }}
                  className="text-sm text-gray-500 hover:text-gray-700"
                >
                  Cancel
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Action button ─────────────────────────────────────────────────────────────

function ActionBtn({
  color, onClick, children, disabled,
}: { color: 'green' | 'red' | 'blue' | 'teal' | 'gray'; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  const styles = {
    green: 'bg-green-50 text-green-700 hover:bg-green-100 border-green-200',
    red: 'bg-red-50 text-red-700 hover:bg-red-100 border-red-200',
    blue: 'bg-blue-50 text-blue-700 hover:bg-blue-100 border-blue-200',
    teal: 'bg-teal-50 text-teal-700 hover:bg-teal-100 border-teal-200',
    gray: 'bg-gray-50 text-gray-500 hover:bg-gray-100 border-gray-200',
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded border px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${styles[color]}`}
    >
      {children}
    </button>
  );
}
