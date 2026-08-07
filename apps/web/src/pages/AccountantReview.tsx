import { useState, FormEvent } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, XCircle, Send, MessageCircleQuestion, FileText } from 'lucide-react';
import { expenseApi, accountantApi } from '../api/expenses';
import { StatusBadge, ReimbursementBadge, ZohoPushBadge } from '../components/StatusBadge';
import { receiptContentUrl } from '../components/ReceiptPreview';
import { useAuth } from '../contexts/AuthContext';
import type { Expense, ExpenseMessage, Receipt } from '../types';

const REQUEST_TYPE_OPTIONS = [
  { value: 'info_request', label: 'General question' },
  { value: 'missing_receipt', label: 'Please upload receipt' },
  { value: 'missing_category', label: 'Please select category' },
  { value: 'missing_payment_method', label: 'Please specify payment method' },
];

function fmtMoney(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Receipt viewer (left pane) ────────────────────────────────────────────────

function ReceiptPane({ expense }: { expense: Expense }) {
  const receipts = expense.receipts ?? [];
  if (receipts.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-gray-300 bg-gray-50 text-sm text-gray-400 lg:h-full lg:min-h-[24rem]">
        No receipt attached
      </div>
    );
  }

  // Show the largest receipt (most likely the real document scan)
  const primary = [...receipts].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))[0];
  const others = receipts.filter((r) => r.id !== primary.id);

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <ReceiptView expenseId={expense.id} receipt={primary} />
      {others.length > 0 && (
        <div className="mt-3 border-t border-gray-100 pt-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-gray-400">
            Other receipts
          </p>
          <ul className="space-y-1">
            {others.map((r) => (
              <li key={r.id}>
                <a
                  href={receiptContentUrl(expense.id, r.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-brand-600 hover:text-brand-700 hover:underline"
                >
                  <FileText className="h-3.5 w-3.5" />
                  {r.filename}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ReceiptView({ expenseId, receipt }: { expenseId: string; receipt: Receipt }) {
  const url = receiptContentUrl(expenseId, receipt.id);
  const isPdf = receipt.mimeType === 'application/pdf'
    || receipt.filename.toLowerCase().endsWith('.pdf');

  if (isPdf) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-lg bg-gray-50 text-sm text-gray-500">
        <FileText className="h-8 w-8 text-gray-300" />
        <p>{receipt.filename}</p>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100"
        >
          Open PDF
        </a>
      </div>
    );
  }

  return (
    <a href={url} target="_blank" rel="noreferrer" className="block" title="Open full size">
      <img
        src={url}
        alt={receipt.filename}
        className="mx-auto max-h-[42rem] w-auto max-w-full rounded-lg border border-gray-200 object-contain"
      />
    </a>
  );
}

// ── Zoho readiness checklist (computed client-side from the loaded expense) ───

function ReadinessLine({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-2 text-xs ${ok ? 'text-green-700' : 'text-red-600'}`}>
      {ok
        ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-600" />
        : <XCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />}
      {label}
    </li>
  );
}

function ZohoReadinessCard({ expense }: { expense: Expense }) {
  const hasReceipt = (expense.receipts?.length ?? 0) > 0;
  const hasCategory = !!(expense.categoryId || expense.zohoExpenseAccountId);
  const hasPayment = !!expense.paymentMethodId;
  const hasCompany = !!expense.zohoEntity;
  const notSynced = !expense.zohoExpenseId;
  const ready = hasReceipt && hasCategory && hasPayment && hasCompany && notSynced && expense.status === 'approved';

  return (
    <div className={`rounded-xl border p-4 ${ready ? 'border-teal-200 bg-teal-50' : 'border-gray-200 bg-white'}`}>
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-700">
        Zoho Readiness
        {ready
          ? <span className="text-xs font-medium text-teal-700">Ready</span>
          : <span className="text-xs font-medium text-gray-400">Not ready</span>}
      </h2>
      <ul className="space-y-1.5">
        <ReadinessLine ok={hasReceipt} label="Receipt attached" />
        <ReadinessLine ok={hasCategory} label="Category set" />
        <ReadinessLine ok={hasPayment} label="Payment method set" />
        <ReadinessLine ok={hasCompany} label="Company set" />
        <ReadinessLine ok={notSynced} label="Not already synced" />
      </ul>
      {expense.zohoExpenseId && (
        <p className="mt-2 text-xs text-gray-500">Zoho ID: {expense.zohoExpenseId}</p>
      )}
    </div>
  );
}

// ── Conversation ──────────────────────────────────────────────────────────────

function MessageItem({
  message,
  currentUserId,
}: {
  message: ExpenseMessage;
  currentUserId?: string;
}) {
  if (message.isSystem) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-center text-xs text-gray-500">
        {message.body}
      </div>
    );
  }

  if (message.requestType) {
    const resolved = message.isResolved;
    return (
      <div className={`rounded-lg border px-3 py-2.5 text-sm ${resolved ? 'border-green-200 bg-green-50' : 'border-amber-300 bg-amber-50'}`}>
        <div className="mb-1 flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1.5">
            <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${resolved ? 'bg-green-100 text-green-700' : 'bg-amber-200 text-amber-800'}`}>
              {resolved ? 'Resolved' : 'Info Requested'}
            </span>
            <span className="font-medium text-gray-700">{message.sender?.name ?? 'Accountant'}</span>
          </div>
          <span className="text-xs text-gray-400">{new Date(message.createdAt).toLocaleString()}</span>
        </div>
        <p className={resolved ? 'text-green-900' : 'text-amber-900'}>{message.body}</p>
        {message.internalNote && (
          <p className="mt-2 rounded border border-yellow-200 bg-yellow-50 px-2 py-1 text-xs text-yellow-800">
            <span className="font-semibold">Internal note: </span>{message.internalNote}
          </p>
        )}
      </div>
    );
  }

  const isMine = message.senderId === currentUserId;
  return (
    <div className={`rounded-lg p-3 text-sm ${isMine ? 'bg-brand-50 text-brand-900' : 'bg-gray-50 text-gray-800'}`}>
      <div className="mb-1 flex items-center gap-2">
        <span className="font-medium">{message.sender?.name ?? '—'}</span>
        {message.sender?.role !== 'user' && (
          <span className="text-xs capitalize opacity-50">{message.sender?.role}</span>
        )}
        <span className="text-xs opacity-60">{new Date(message.createdAt).toLocaleString()}</span>
      </div>
      <p>{message.body}</p>
    </div>
  );
}

// ── Detail row ────────────────────────────────────────────────────────────────

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="shrink-0 text-gray-400">{label}</dt>
      <dd className="text-right font-medium text-gray-800">{value}</dd>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function AccountantReview() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [showAskForm, setShowAskForm] = useState(false);
  const [askNote, setAskNote] = useState('');
  const [askType, setAskType] = useState('info_request');
  const [askInternal, setAskInternal] = useState('');
  const [reply, setReply] = useState('');

  const { data: expense, isLoading } = useQuery({
    queryKey: ['expense', id],
    queryFn: () => expenseApi.get(id!),
    enabled: !!id,
  });

  const reviewMutation = useMutation({
    mutationFn: ({ action, note, requestType, internalNote }: {
      action: 'approve' | 'reject' | 'request_info';
      note?: string;
      requestType?: string;
      internalNote?: string;
    }) => accountantApi.review(id!, { action, note, requestType, internalNote }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['accountant-queue'] });
      qc.invalidateQueries({ queryKey: ['accountant-queue-summary'] });
      qc.invalidateQueries({ queryKey: ['expense', id] });
      if (variables.action === 'approve' || variables.action === 'reject') {
        navigate('/accountant');
      } else {
        setShowAskForm(false);
        setAskNote('');
        setAskType('info_request');
        setAskInternal('');
      }
    },
  });

  const messageMutation = useMutation({
    mutationFn: (body: string) => expenseApi.postMessage(id!, body),
    onSuccess: () => {
      setReply('');
      qc.invalidateQueries({ queryKey: ['expense', id] });
    },
  });

  function submitAsk() {
    if (!askNote.trim()) return;
    reviewMutation.mutate({
      action: 'request_info',
      note: askNote.trim(),
      requestType: askType,
      internalNote: askInternal.trim() || undefined,
    });
  }

  function handleReply(e: FormEvent) {
    e.preventDefault();
    if (!reply.trim()) return;
    messageMutation.mutate(reply.trim());
  }

  if (isLoading) return <div className="p-8 text-gray-400">Loading…</div>;
  if (!expense) return <div className="p-8 text-red-600">Expense not found</div>;

  const canReview =
    expense.status === 'pending' ||
    expense.status === 'in_review' ||
    expense.status === 'awaiting_info';

  return (
    <div>
      {/* Sticky header */}
      <div className="sticky top-0 z-10 border-b border-gray-200 bg-white px-4 py-3 lg:px-8">
        <div className="flex flex-wrap items-center gap-3">
          <Link to="/accountant" className="rounded p-1 text-gray-400 hover:bg-gray-100" aria-label="Back to queue">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div className="flex min-w-0 flex-1 items-center gap-3 flex-wrap">
            <h1 className="truncate text-lg font-bold text-gray-900">{expense.merchant}</h1>
            <StatusBadge status={expense.status} variant="accountant" />
            <ZohoPushBadge
              zohoExpenseId={expense.zohoExpenseId}
              syncFailed={expense.status === 'zoho_sync_failed'}
            />
            {expense.reimbursementStatus !== 'not_requested' && (
              <ReimbursementBadge status={expense.reimbursementStatus} />
            )}
            <span className="text-lg font-bold text-gray-900">
              {fmtMoney(Number(expense.amount || 0))}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => reviewMutation.mutate({ action: 'approve' })}
              disabled={!canReview || reviewMutation.isPending}
              className="flex items-center gap-1.5 rounded-lg bg-green-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-40"
            >
              <CheckCircle2 className="h-4 w-4" />
              Approve
            </button>
            <button
              onClick={() => reviewMutation.mutate({ action: 'reject' })}
              disabled={!canReview || reviewMutation.isPending}
              className="flex items-center gap-1.5 rounded-lg bg-red-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-40"
            >
              <XCircle className="h-4 w-4" />
              Reject
            </button>
            <button
              onClick={() => setShowAskForm((v) => !v)}
              disabled={!canReview || reviewMutation.isPending}
              className="flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3.5 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-40"
            >
              <MessageCircleQuestion className="h-4 w-4" />
              Ask
            </button>
          </div>
        </div>

        {!canReview && (
          <p className="mt-2 text-xs text-gray-400">
            This expense is in status &lsquo;{expense.status}&rsquo; and cannot be reviewed from here.
          </p>
        )}

        {/* Ask form */}
        {showAskForm && (
          <div className="mt-3 space-y-2 rounded-xl border border-blue-200 bg-blue-50 p-3">
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
                disabled={!askNote.trim() || reviewMutation.isPending}
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
        )}
      </div>

      {/* Split panes */}
      <div className="grid grid-cols-1 gap-6 p-4 lg:grid-cols-2 lg:p-8">
        {/* Left: receipt viewer */}
        <div>
          <ReceiptPane expense={expense} />
        </div>

        {/* Right: details, readiness, conversation */}
        <div className="space-y-4">
          {/* Expense details */}
          <div className="rounded-xl border border-gray-200 bg-white p-5 text-sm">
            <h2 className="mb-3 font-semibold text-gray-700">Expense Details</h2>
            <dl className="space-y-2 text-gray-600">
              <DetailRow label="Merchant" value={expense.merchant} />
              <DetailRow label="Amount" value={`${expense.currency} ${Number(expense.amount).toFixed(2)}`} />
              <DetailRow label="Date" value={expense.date} />
              <DetailRow
                label="Category"
                value={expense.zohoExpenseAccountName ?? expense.category?.name ?? '—'}
              />
              <DetailRow
                label="Payment method"
                value={expense.paymentMethod
                  ? `${expense.paymentMethod.label}${expense.paymentMethod.lastFour ? ` ···${expense.paymentMethod.lastFour}` : ''}`
                  : '—'}
              />
              <DetailRow label="Company" value={expense.zohoEntity ?? '—'} />
              <DetailRow label="Submitted by" value={expense.user?.name ?? '—'} />
            </dl>
            {expense.description && (
              <div className="mt-3 border-t border-gray-100 pt-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">Notes</p>
                <p className="mt-1 text-sm text-gray-600">{expense.description}</p>
              </div>
            )}
          </div>

          {/* Zoho readiness */}
          <ZohoReadinessCard expense={expense} />

          {/* Conversation */}
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-gray-700">Conversation</h2>
            <div className="mb-4 max-h-80 space-y-3 overflow-y-auto">
              {expense.messages && expense.messages.length > 0 ? (
                expense.messages.map((m) => (
                  <MessageItem key={m.id} message={m} currentUserId={user?.id} />
                ))
              ) : (
                <p className="text-sm text-gray-400">No messages yet.</p>
              )}
            </div>
            <form onSubmit={handleReply} className="flex gap-2">
              <input
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="Add a note or reply…"
                className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={!reply.trim() || messageMutation.isPending}
                className="rounded-lg bg-brand-600 px-3 py-2 text-white hover:bg-brand-700 disabled:opacity-60"
              >
                <Send className="h-4 w-4" />
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
