import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, XCircle, Send, MessageCircleQuestion, FileText } from 'lucide-react';
import { expenseApi, accountantApi } from '../api/expenses';
import { StatusBadge, ReimbursementBadge, ZohoPushBadge } from '../components/StatusBadge';
import { ZohoSyncCard } from '../components/ZohoSyncCard';
import { AccountantDetailsEdit } from '../components/AccountantDetailsEdit';
import { MessageBubble } from '../components/MessageBubble';
import { MessageComposer } from '../components/MessageComposer';
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

/**
 * Web-side mirror of apps/api/src/lib/queueScope.ts#isDailyExpense.
 * Only one call site needs this, so it lives inline rather than in a shared module.
 */
function isDailyExpense(sourceApp: string | null | undefined): boolean {
  return sourceApp == null || sourceApp === 'browser_extension';
}

// ── Receipt viewer (left pane) ────────────────────────────────────────────────

function ReceiptPane({ expense }: { expense: Expense }) {
  const receipts = expense.receipts ?? [];
  if (receipts.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-ink/15 bg-cream text-sm text-charcoal/40 lg:h-full lg:min-h-[24rem]">
        No receipt attached
      </div>
    );
  }

  // Show the largest receipt (most likely the real document scan)
  const primary = [...receipts].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))[0];
  const others = receipts.filter((r) => r.id !== primary.id);

  return (
    <div className="rounded-xl border border-ink/10 bg-white p-4 shadow-panel">
      <ReceiptView expenseId={expense.id} receipt={primary} />
      {others.length > 0 && (
        <div className="mt-3 border-t border-ink/5 pt-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-charcoal/40">
            Other receipts
          </p>
          <ul className="space-y-1">
            {others.map((r) => (
              <li key={r.id}>
                <a
                  href={receiptContentUrl(expense.id, r.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-11 max-w-full items-center gap-1.5 text-sm text-brand-600 hover:text-brand-700 hover:underline lg:min-h-0"
                >
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                  <span className="break-all">{r.filename}</span>
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
      <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-lg bg-cream text-sm text-muted">
        <FileText className="h-8 w-8 text-charcoal/25" />
        <p>{receipt.filename}</p>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-11 items-center rounded-lg border border-ink/15 px-3 py-1.5 text-xs font-medium text-charcoal/80 hover:bg-brand-50 lg:min-h-0"
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
        className="mx-auto max-h-[70vh] w-auto max-w-full rounded-lg border border-ink/10 object-contain lg:max-h-[42rem]"
      />
    </a>
  );
}

// ── Zoho readiness checklist (computed client-side from the loaded expense) ───

function ReadinessLine({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-2 text-xs ${ok ? 'text-success' : 'text-danger'}`}>
      {ok
        ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
        : <XCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />}
      {label}
    </li>
  );
}

function ZohoReadinessCard({
  expense,
  onPush,
  pushing,
}: {
  expense: Expense;
  onPush: () => void;
  pushing: boolean;
}) {
  if (expense.zohoExpenseId) return null;

  const hasReceipt = (expense.receipts?.length ?? 0) > 0;
  const hasCategory = !!(expense.categoryId || expense.zohoExpenseAccountId);
  const hasPayment = !!expense.paymentMethodId;
  // Push refuses cards without a Zoho paid-through mapping — mirror that here.
  const hasPaidThrough = !!expense.paymentMethod?.zohoAccountName;
  const hasCompany = !!expense.zohoEntity;
  const ready = hasReceipt && hasCategory && hasPayment && hasPaidThrough && hasCompany && expense.status === 'approved';
  const failed: string[] = [];
  if (!hasReceipt) failed.push('Receipt attached');
  if (!hasCategory) failed.push('Category set');
  if (!hasPayment) failed.push('Payment method set');
  if (hasPayment && !hasPaidThrough) failed.push('Payment method mapped to a Zoho account (Settings → Payment Methods)');
  if (!hasCompany) failed.push('Company set');
  if (expense.status !== 'approved' && expense.status !== 'zoho_sync_failed') failed.push('Approved');

  return (
    <div className={`rounded-xl border p-4 ${ready ? 'border-success/30 bg-success/10' : 'border-ink/10 bg-white'}`}>
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-charcoal/80">
        Zoho push
        {ready
          ? <span className="text-xs font-medium text-success">Ready</span>
          : <span className="text-xs font-medium text-muted">Not ready</span>}
      </h2>
      {ready ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-success">All push checks passed.</p>
          {/* Pushing from here saves a trip back to the queue — the whole
              point of landing on this page to check the receipt first. */}
          <button
            type="button"
            onClick={onPush}
            disabled={pushing}
            className="min-h-11 cursor-pointer rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-cream shadow-sm transition-colors hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-0"
          >
            {pushing ? 'Pushing…' : 'Push to Zoho'}
          </button>
        </div>
      ) : (
        <ul className="space-y-1.5">
          {failed.length === 0 ? (
            // Every check passes but the status is zoho_sync_failed — the
            // retry lives in the sync card below, so don't render a blank list.
            <li className="text-xs text-amber-800">A previous push failed — retry it below.</li>
          ) : (
            failed.map((label) => <ReadinessLine key={label} ok={false} label={label} />)
          )}
        </ul>
      )}
    </div>
  );
}

// ── Conversation ──────────────────────────────────────────────────────────────

// ── Detail row ────────────────────────────────────────────────────────────────

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4">
      <dt className="text-charcoal/40 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 break-words font-medium text-ink sm:text-right">{value}</dd>
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
  const [replyError, setReplyError] = useState<string | null>(null);

  const { data: expense, isLoading } = useQuery({
    queryKey: ['expense', id],
    queryFn: () => expenseApi.get(id!),
    enabled: !!id,
  });

  const queueBackTo = isDailyExpense(expense?.sourceApp) ? '/accountant/daily' : '/accountant/events';

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
        navigate(queueBackTo);
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
      setReplyError(null);
      qc.invalidateQueries({ queryKey: ['expense', id] });
    },
    onError: (err: unknown) => {
      // Keep the text in the box — a dropped message is worse than a retry.
      setReplyError(
        (err as { response?: { data?: { error?: { message?: string } } } })
          ?.response?.data?.error?.message ?? 'Could not send your message. Please try again.',
      );
    },
  });

  const [zohoPushError, setZohoPushError] = useState('');
  const zohoRetryMutation = useMutation({
    mutationFn: () => accountantApi.pushToZoho(id!),
    onMutate: () => setZohoPushError(''),
    onError: (err: any) => {
      setZohoPushError(err?.response?.data?.error?.message ?? 'Zoho push failed.');
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['expense', id] });
      qc.invalidateQueries({ queryKey: ['accountant-queue'] });
      qc.invalidateQueries({ queryKey: ['accountant-queue-summary'] });
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

  if (isLoading) return <div className="p-8 text-charcoal/40">Loading…</div>;
  if (!expense) return <div className="p-8 text-danger">Expense not found</div>;

  const canReview =
    expense.status === 'pending' ||
    expense.status === 'in_review' ||
    expense.status === 'awaiting_info';

  return (
    <div>
      {/* Sticky header */}
      <div className="sticky top-0 z-10 border-b border-ink/10 bg-white/95 px-4 pr-14 py-3 backdrop-blur lg:px-8">
        <div className="flex flex-wrap items-center gap-3">
          <Link to={queueBackTo} className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded p-1 text-charcoal/40 hover:bg-ink/[0.04] lg:min-h-0 lg:min-w-0" aria-label="Back to queue">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
            <h1 className="truncate font-display text-xl font-semibold text-ink">{expense.merchant}</h1>
            <StatusBadge status={expense.status} variant="accountant" />
            <ZohoPushBadge
              zohoExpenseId={expense.zohoExpenseId}
              syncFailed={expense.status === 'zoho_sync_failed'}
            />
            {expense.reimbursementStatus !== 'not_requested' && (
              <ReimbursementBadge status={expense.reimbursementStatus} />
            )}
            <span className="font-display text-lg font-semibold text-ink">
              {fmtMoney(Number(expense.amount || 0))}
            </span>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <button
              onClick={() => reviewMutation.mutate({ action: 'approve' })}
              disabled={!canReview || reviewMutation.isPending}
              className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-success px-3.5 py-2 text-sm font-semibold text-cream hover:opacity-90 disabled:opacity-40 sm:flex-none lg:min-h-0"
            >
              <CheckCircle2 className="h-4 w-4" />
              Approve
            </button>
            <button
              onClick={() => reviewMutation.mutate({ action: 'reject' })}
              disabled={!canReview || reviewMutation.isPending}
              className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-danger px-3.5 py-2 text-sm font-semibold text-cream hover:opacity-90 disabled:opacity-40 sm:flex-none lg:min-h-0"
            >
              <XCircle className="h-4 w-4" />
              Reject
            </button>
            <button
              onClick={() => setShowAskForm((v) => !v)}
              disabled={!canReview || reviewMutation.isPending}
              className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-brand-500/30 bg-brand-500/10 px-3.5 py-2 text-sm font-semibold text-brand-800 hover:bg-brand-500/15 disabled:opacity-40 sm:flex-none lg:min-h-0"
            >
              <MessageCircleQuestion className="h-4 w-4" />
              Ask
            </button>
          </div>
        </div>

        {reviewMutation.isError && (
          <p className="mt-2 text-xs font-medium text-danger">
            {(reviewMutation.error as { response?: { data?: { error?: { message?: string } } } })
              ?.response?.data?.error?.message ?? 'Review failed. Please try again.'}
          </p>
        )}

        {!canReview && (
          <p className="mt-2 text-xs text-charcoal/40">
            This expense is in status &lsquo;{expense.status}&rsquo; and cannot be reviewed from here.
          </p>
        )}

        {/* Ask form */}
        {showAskForm && (
          <div className="mt-3 space-y-2 rounded-xl border border-brand-200 bg-brand-50 p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
              <select
                value={askType}
                onChange={(e) => setAskType(e.target.value)}
                className="w-full rounded-lg border border-brand-300 bg-white px-2 py-3 text-sm focus:outline-none sm:w-auto lg:py-1.5"
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
                className="min-w-0 rounded-lg border border-brand-300 px-3 py-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 sm:flex-1 lg:py-1.5"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={askInternal}
                onChange={(e) => setAskInternal(e.target.value)}
                placeholder="Internal note (not shown to employee, optional)"
                className="w-full min-w-0 rounded-lg border border-ink/15 bg-cream px-3 py-3 text-xs text-charcoal/70 focus:outline-none focus:ring-1 focus:ring-brand-500 sm:w-auto sm:flex-1 lg:py-1.5"
              />
              <button
                onClick={submitAsk}
                disabled={!askNote.trim() || reviewMutation.isPending}
                className="flex min-h-11 items-center gap-1 rounded-lg bg-brand-500 px-3 py-1.5 text-sm text-cream hover:bg-brand-600 disabled:opacity-50 lg:min-h-0"
              >
                <Send className="h-3.5 w-3.5" />
                Send
              </button>
              <button
                onClick={() => { setShowAskForm(false); setAskNote(''); }}
                className="min-h-11 px-2 text-sm text-muted hover:text-ink lg:min-h-0 lg:px-0"
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
          <div className="rounded-xl border border-ink/10 bg-white p-5 text-sm">
            <h2 className="mb-3 font-semibold text-charcoal/80">Expense Details</h2>
            <dl className="space-y-2 text-charcoal/70">
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
              <div className="mt-3 border-t border-ink/5 pt-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-charcoal/40">Notes</p>
                <p className="mt-1 break-words text-sm text-charcoal/70">{expense.description}</p>
              </div>
            )}
          </div>

          {/* Correct push blockers without a round-trip to the submitter */}
          <AccountantDetailsEdit expense={expense} />

          {/* Zoho readiness */}
          <ZohoReadinessCard
            expense={expense}
            onPush={() => zohoRetryMutation.mutate()}
            pushing={zohoRetryMutation.isPending}
          />

          {/* Zoho sync history */}
          {zohoPushError && (
            <div className="rounded-xl border border-danger/25 bg-danger/10 px-4 py-3 text-sm text-danger">
              {zohoPushError}
            </div>
          )}
          <ZohoSyncCard
            expense={expense}
            onRetry={() => zohoRetryMutation.mutate()}
            retrying={zohoRetryMutation.isPending}
          />

          {/* Conversation */}
          <div className="rounded-xl border border-ink/10 bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-charcoal/80">Conversation</h2>
            <div className="mb-4 max-h-80 space-y-3 overflow-y-auto">
              {expense.messages && expense.messages.length > 0 ? (
                expense.messages.map((m) => (
                  <MessageBubble key={m.id} message={m} currentUserId={user?.id} isPrivileged />
                ))
              ) : (
                <p className="text-sm text-charcoal/40">No messages yet.</p>
              )}
            </div>
            <MessageComposer
              value={reply}
              onChange={setReply}
              onSubmit={() => messageMutation.mutate(reply.trim())}
              pending={messageMutation.isPending}
              error={replyError}
              placeholder="Add a note or reply…"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
