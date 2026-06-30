import { useState, FormEvent, ChangeEvent } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Paperclip, Send, Upload, AlertCircle, CheckCircle2,
  Clock, XCircle, RefreshCw, CreditCard, Tag, FileX, Building2,
} from 'lucide-react';
import { expenseApi, accountantApi } from '../api/expenses';
import { StatusBadge, ReimbursementBadge } from '../components/StatusBadge';
import { useAuth } from '../contexts/AuthContext';
import type { Expense, ExpenseMessage, MessageRequestType, AuditLogEntry } from '../types';

// ── Status banner — human language per workflow state ─────────────────────────

const USER_STATUS_CONTEXT: Record<string, {
  icon: React.ReactNode;
  color: string;
  title: string;
  body: string;
}> = {
  pending: {
    icon: <Clock className="h-4 w-4 text-yellow-600" />,
    color: 'border-yellow-200 bg-yellow-50 text-yellow-800',
    title: 'Submitted — waiting for review',
    body: 'Your expense is in the accountant review queue.',
  },
  in_review: {
    icon: <AlertCircle className="h-4 w-4 text-blue-600" />,
    color: 'border-blue-200 bg-blue-50 text-blue-800',
    title: 'Under review',
    body: 'An accountant is currently reviewing this expense.',
  },
  awaiting_info: {
    icon: <AlertCircle className="h-4 w-4 text-amber-600" />,
    color: 'border-amber-300 bg-amber-50 text-amber-900',
    title: 'Action needed — your accountant has a question',
    body: 'Please reply in the conversation below. Your expense returns to review automatically after you respond.',
  },
  approved: {
    icon: <CheckCircle2 className="h-4 w-4 text-green-600" />,
    color: 'border-green-200 bg-green-50 text-green-800',
    title: 'Approved',
    body: 'Your expense has been approved.',
  },
  zoho_sync_failed: {
    icon: <RefreshCw className="h-4 w-4 text-orange-600" />,
    color: 'border-orange-200 bg-orange-50 text-orange-800',
    title: 'Sent to accounting',
    body: 'Your expense was approved and is being processed.',
  },
  rejected: {
    icon: <XCircle className="h-4 w-4 text-red-600" />,
    color: 'border-red-200 bg-red-50 text-red-800',
    title: 'Rejected',
    body: 'This expense was not approved. See the conversation below for details.',
  },
};

function StatusBanner({ status, isPrivileged }: { status: string; isPrivileged: boolean }) {
  const ctx = isPrivileged ? undefined : USER_STATUS_CONTEXT[status];
  if (!ctx) return null;
  return (
    <div className={`mb-6 flex items-start gap-3 rounded-xl border p-4 ${ctx.color}`}>
      <span className="mt-0.5 shrink-0">{ctx.icon}</span>
      <div>
        <p className="text-sm font-semibold">{ctx.title}</p>
        <p className="mt-0.5 text-sm opacity-80">{ctx.body}</p>
      </div>
    </div>
  );
}

// ── Zoho readiness panel (accountant only) ────────────────────────────────────

function ZohoReadinessPanel({ expense }: { expense: Expense }) {
  if (!expense) return null;
  const flags = expense.flags ?? [];

  const checks = [
    { label: 'Approved', pass: expense.status === 'approved' || expense.status === 'zoho_sync_failed', icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
    { label: 'Category set', pass: !!expense.categoryId, icon: <Tag className="h-3.5 w-3.5" /> },
    { label: 'Payment method set', pass: !!expense.paymentMethodId, icon: <CreditCard className="h-3.5 w-3.5" /> },
    { label: 'Accounting entity set', pass: !!expense.zohoEntity, icon: <Building2 className="h-3.5 w-3.5" /> },
    { label: 'Receipt attached', pass: (expense.receipts?.length ?? 0) > 0, icon: <FileX className="h-3.5 w-3.5" /> },
    { label: 'Not yet pushed to Zoho', pass: !expense.zohoExpenseId, icon: <RefreshCw className="h-3.5 w-3.5" /> },
  ];

  const allPass = checks.every((c) => c.pass);
  const isSynced = !!expense.zohoExpenseId;

  return (
    <div className={`rounded-xl border p-4 ${isSynced ? 'border-green-200 bg-green-50' : allPass ? 'border-teal-200 bg-teal-50' : 'border-gray-200 bg-white'}`}>
      <h2 className="mb-1 text-sm font-semibold text-gray-700">
        Zoho Readiness
        {isSynced && <span className="ml-2 text-xs text-green-700 font-medium">Synced</span>}
        {!isSynced && allPass && <span className="ml-2 text-xs text-teal-700 font-medium">Ready</span>}
      </h2>
      <p className="mb-3 text-xs text-amber-700 bg-amber-50 rounded px-2 py-1">Zoho is in mock mode — no real sync occurs</p>
      <ul className="space-y-1.5">
        {checks.map((c) => (
          <li key={c.label} className={`flex items-center gap-2 text-xs ${c.pass ? 'text-green-700' : 'text-red-600'}`}>
            <span className={c.pass ? 'text-green-600' : 'text-red-400'}>{c.icon}</span>
            {c.label}
          </li>
        ))}
      </ul>
      {isSynced && expense.zohoExpenseId && (
        <p className="mt-2 text-xs text-green-700 font-medium">Zoho ID: {expense.zohoExpenseId}</p>
      )}
    </div>
  );
}

// ── Message bubble ────────────────────────────────────────────────────────────

const REQUEST_TYPE_LABELS: Partial<Record<MessageRequestType, string>> = {
  missing_receipt: 'Please upload receipt',
  missing_category: 'Please select category',
  missing_payment_method: 'Please specify payment method',
  info_request: 'Info Requested',
  general: 'Question',
};

function MessageBubble({
  message,
  currentUserId,
  isPrivileged,
}: {
  message: ExpenseMessage;
  currentUserId?: string;
  isPrivileged: boolean;
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
    const typeLabel = REQUEST_TYPE_LABELS[message.requestType as MessageRequestType] ?? 'Info Requested';
    return (
      <div className={`rounded-lg border px-3 py-2.5 text-sm ${resolved ? 'border-green-200 bg-green-50' : 'border-amber-300 bg-amber-50'}`}>
        <div className="mb-1.5 flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1.5">
            <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${resolved ? 'bg-green-100 text-green-700' : 'bg-amber-200 text-amber-800'}`}>
              {resolved ? 'Resolved' : typeLabel}
            </span>
            <span className="font-medium text-gray-700">{message.sender?.name ?? 'Accountant'}</span>
          </div>
          <span className="text-xs text-gray-400">{new Date(message.createdAt).toLocaleString()}</span>
        </div>
        <p className={resolved ? 'text-green-900' : 'text-amber-900'}>{message.body}</p>
        {isPrivileged && message.internalNote && (
          <p className="mt-2 rounded bg-yellow-50 border border-yellow-200 px-2 py-1 text-xs text-yellow-800">
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
          <span className="text-xs opacity-50 capitalize">{message.sender?.role}</span>
        )}
        <span className="text-xs opacity-60">{new Date(message.createdAt).toLocaleString()}</span>
      </div>
      <p>{message.body}</p>
    </div>
  );
}

// ── Recent Activity panel (accountant/admin) ──────────────────────────────────

const ACTION_LABELS: Record<string, string> = {
  'review.claimed': 'Claimed for review',
  'review.released': 'Claim released',
  'review.approve': 'Approved',
  'review.reject': 'Rejected',
  'review.request_info': 'Info requested',
  'info_request_resolved': 'Requests resolved',
  'reimbursement.updated': 'Reimbursement updated',
  'zoho.pushed': 'Pushed to Zoho [mock]',
  'zoho.failed': 'Zoho push failed [mock]',
  'zoho_entity.set': 'Zoho entity set',
  'submitted': 'Submitted for review',
  'created': 'Expense created',
  'updated': 'Fields updated',
  'uploaded': 'Receipt uploaded',
  'user_responded': 'Employee replied',
  'receipt_attached_from_extension': 'Receipt attached (extension)',
  'expense_created_from_extension': 'Created via extension',
  'ext.created': 'Created via app API',
  'capture_linked_to_expense': 'Screenshot linked',
};

const ACTION_COLORS: Record<string, string> = {
  'review.approve': 'bg-green-100 text-green-700',
  'review.reject': 'bg-red-100 text-red-700',
  'review.claimed': 'bg-blue-100 text-blue-700',
  'review.request_info': 'bg-amber-100 text-amber-700',
  'submitted': 'bg-brand-100 text-brand-700',
  'zoho.pushed': 'bg-teal-100 text-teal-700',
  'zoho.failed': 'bg-orange-100 text-orange-700',
};

function RecentActivity({ expenseId }: { expenseId: string }) {
  const { data: entries = [], isLoading } = useQuery({
    queryKey: ['expense-audit', expenseId],
    queryFn: () => accountantApi.getAuditTrail(expenseId),
  });

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-gray-700">Recent Activity</h2>
      {isLoading ? (
        <p className="text-xs text-gray-400">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-gray-400">No activity recorded yet.</p>
      ) : (
        <ol className="space-y-2">
          {entries.map((entry: AuditLogEntry) => {
            const label = ACTION_LABELS[entry.action] ?? entry.action;
            const color = ACTION_COLORS[entry.action] ?? 'bg-gray-100 text-gray-600';
            const who = entry.actorName ?? 'System';
            const when = new Date(entry.createdAt).toLocaleString(undefined, {
              month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
            });
            return (
              <li key={entry.id} className="flex items-start gap-2 text-xs">
                <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 font-medium ${color}`}>
                  {label}
                </span>
                <span className="text-gray-500 leading-5">
                  {who} · {when}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function ExpenseDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const [message, setMessage] = useState('');
  // Set when arriving here from New Expense after the draft was created but the
  // receipt upload failed. Dismissed once a receipt is successfully uploaded.
  const [receiptUploadFailed, setReceiptUploadFailed] = useState(
    () => (location.state as { receiptUploadFailed?: boolean } | null)?.receiptUploadFailed ?? false,
  );

  const { data: expense, isLoading } = useQuery({
    queryKey: ['expense', id],
    queryFn: () => expenseApi.get(id!),
    enabled: !!id,
  });

  const submitMutation = useMutation({
    mutationFn: () => expenseApi.submit(id!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expense', id] }),
  });

  const messageMutation = useMutation({
    mutationFn: (body: string) => expenseApi.postMessage(id!, body),
    onSuccess: () => {
      setMessage('');
      qc.invalidateQueries({ queryKey: ['expense', id] });
    },
  });

  const uploadMutation = useMutation({
    mutationFn: (file: File) => expenseApi.uploadReceipt(id!, file),
    onSuccess: () => {
      setReceiptUploadFailed(false);
      qc.invalidateQueries({ queryKey: ['expense', id] });
    },
  });

  const resolveMutation = useMutation({
    mutationFn: () => accountantApi.resolveRequest(id!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expense', id] }),
  });

  const releaseClaimMutation = useMutation({
    mutationFn: () => accountantApi.releaseClaim(id!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expense', id] }),
  });

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) uploadMutation.mutate(file);
    e.target.value = '';
  }

  function handleSendMessage(e: FormEvent) {
    e.preventDefault();
    if (!message.trim()) return;
    messageMutation.mutate(message.trim());
  }

  if (isLoading) return <div className="p-8 text-gray-400">Loading…</div>;
  if (!expense) return <div className="p-8 text-red-600">Expense not found</div>;

  const isOwner = expense.userId === user?.id;
  const isPrivileged = user?.role === 'accountant' || user?.role === 'admin';
  const isDraft = expense.status === 'draft';
  const isAwaiting = expense.status === 'awaiting_info';
  const hasOpenRequest = expense.messages?.some(
    (m) => m.requestType && !m.isResolved,
  ) ?? false;

  return (
    <div className="p-8">
      {/* Header */}
      <div className="mb-4 flex items-start gap-4">
        <button onClick={() => navigate(-1)} className="mt-0.5 rounded p-1 text-gray-400 hover:bg-gray-100">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-gray-900">{expense.merchant}</h1>
            <StatusBadge status={expense.status} variant={isPrivileged ? 'accountant' : 'user'} />
            {expense.reimbursementStatus !== 'not_requested' && (
              <ReimbursementBadge status={expense.reimbursementStatus} />
            )}
            {expense.sourceApp === 'browser_extension' && (
              <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700">
                Browser extension
              </span>
            )}
            {expense.sourceApp && expense.sourceApp !== 'browser_extension' && (
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">via {expense.sourceApp}</span>
            )}
          </div>
          <p className="mt-1 text-sm text-gray-500">
            {expense.date}
            {expense.category && <span> · {expense.category.name}</span>}
            {expense.paymentMethod && (
              <span>
                {' · '}
                <span className="inline-flex items-center gap-0.5">
                  <CreditCard className="h-3 w-3" />
                  {expense.paymentMethod.label}
                  {expense.paymentMethod.lastFour && ` ···${expense.paymentMethod.lastFour}`}
                </span>
              </span>
            )}
          </p>
        </div>
        <p className="text-2xl font-bold text-gray-900">
          {expense.currency} {Number(expense.amount).toFixed(2)}
        </p>
      </div>

      {/* Receipt upload failed during creation — prompt a retry */}
      {receiptUploadFailed && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border-2 border-amber-400 bg-amber-50 p-4">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div>
            <p className="text-sm font-semibold text-amber-900">Receipt not attached</p>
            <p className="mt-0.5 text-sm text-amber-800">
              This draft was created, but the receipt image didn&apos;t upload. Use the <span className="font-medium">Upload</span> button under Receipts below to add it.
            </p>
          </div>
        </div>
      )}

      {/* Status banner — user-facing only */}
      {!isPrivileged && <StatusBanner status={expense.status} isPrivileged={false} />}

      {/* Action-needed callout for users */}
      {isOwner && isAwaiting && (
        <div className="mb-6 rounded-xl border-2 border-amber-400 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">Your accountant is waiting for your reply.</p>
          <p className="mt-1 text-sm text-amber-800">Scroll down to the conversation and reply to unblock your expense.</p>
        </div>
      )}

      <div className="grid grid-cols-3 gap-6">
        {/* Main column */}
        <div className="col-span-2 space-y-6">
          {expense.description && (
            <div className="rounded-xl border border-gray-200 bg-white p-5">
              <h2 className="mb-2 text-sm font-semibold text-gray-700">Description</h2>
              <p className="text-sm text-gray-600">{expense.description}</p>
            </div>
          )}

          {/* Receipts */}
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-700">Receipts</h2>
              {(isOwner || isPrivileged) && (
                <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
                  <Upload className="h-3.5 w-3.5" />
                  {uploadMutation.isPending ? 'Uploading…' : 'Upload'}
                  <input type="file" accept="image/*,.pdf" className="hidden" onChange={handleFileChange} />
                </label>
              )}
            </div>
            {expense.receipts && expense.receipts.length > 0 ? (
              <div className="space-y-2">
                {expense.receipts.map((r) => (
                  <div key={r.id} className="flex items-center gap-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                    <Paperclip className="h-4 w-4 shrink-0 text-gray-400" />
                    <span className="flex-1 truncate text-sm text-gray-700">{r.filename}</span>
                    <span className={`text-xs ${r.ocrStatus === 'done' ? 'text-green-600' : r.ocrStatus === 'failed' ? 'text-red-500' : 'text-gray-400'}`}>
                      OCR: {r.ocrStatus} [mock]
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-400">
                No receipts attached.{isOwner && ' You can upload a receipt using the button above.'}
              </p>
            )}
          </div>

          {/* Conversation */}
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-700">
                {isPrivileged ? 'Conversation & Requests' : 'Messages'}
              </h2>
              {isPrivileged && isAwaiting && hasOpenRequest && (
                <button
                  onClick={() => resolveMutation.mutate()}
                  disabled={resolveMutation.isPending}
                  className="text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50"
                >
                  {resolveMutation.isPending ? 'Resolving…' : 'Mark all resolved'}
                </button>
              )}
            </div>
            <div className="mb-4 max-h-80 space-y-3 overflow-y-auto">
              {expense.messages && expense.messages.length > 0 ? (
                expense.messages.map((m) => (
                  <MessageBubble
                    key={m.id}
                    message={m}
                    currentUserId={user?.id}
                    isPrivileged={!!isPrivileged}
                  />
                ))
              ) : (
                <p className="text-sm text-gray-400">No messages yet.</p>
              )}
            </div>
            <form onSubmit={handleSendMessage} className="flex gap-2">
              <input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={
                  isAwaiting && isOwner
                    ? "Reply to the accountant's question…"
                    : isPrivileged
                    ? 'Add a note or reply…'
                    : 'Write a message…'
                }
                className={`flex-1 rounded-lg border px-3 py-2 text-sm focus:outline-none ${
                  isAwaiting && isOwner
                    ? 'border-amber-300 bg-amber-50 focus:border-amber-500'
                    : 'border-gray-300 focus:border-brand-500'
                }`}
              />
              <button
                type="submit"
                disabled={!message.trim() || messageMutation.isPending}
                className="rounded-lg bg-brand-600 px-3 py-2 text-white hover:bg-brand-700 disabled:opacity-60"
              >
                <Send className="h-4 w-4" />
              </button>
            </form>
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Draft submit action */}
          {isOwner && isDraft && (
            <div className="rounded-xl border border-gray-200 bg-white p-5">
              <h2 className="mb-3 text-sm font-semibold text-gray-700">Actions</h2>
              <button
                onClick={() => submitMutation.mutate()}
                disabled={submitMutation.isPending}
                className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
              >
                {submitMutation.isPending ? 'Submitting…' : 'Submit for Review'}
              </button>
              <p className="mt-2 text-xs text-gray-400">Once submitted, your accountant will review this expense.</p>
            </div>
          )}

          {/* Release claim — accountant only, in_review only */}
          {isPrivileged && expense.status === 'in_review' && (
            <div className="rounded-xl border border-gray-200 bg-white p-5">
              <h2 className="mb-1 text-sm font-semibold text-gray-700">Claim</h2>
              {expense.reviewedBy && (
                <p className="mb-3 text-xs text-gray-500">
                  Reviewing: <span className="font-medium text-gray-700">{expense.reviewedBy.name}</span>
                  {expense.reviewedAt && (
                    <span className="ml-1 text-gray-400">
                      · {new Date(expense.reviewedAt).toLocaleString()}
                    </span>
                  )}
                </p>
              )}
              <button
                onClick={() => releaseClaimMutation.mutate()}
                disabled={releaseClaimMutation.isPending}
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-60"
              >
                {releaseClaimMutation.isPending ? 'Releasing…' : 'Release Claim'}
              </button>
              <p className="mt-2 text-xs text-gray-400">Returns the expense to the Needs Review queue.</p>
            </div>
          )}

          {/* Zoho readiness — accountant only */}
          {isPrivileged && (
            <ZohoReadinessPanel expense={expense} />
          )}

          {/* Recent Activity — accountant only */}
          {isPrivileged && <RecentActivity expenseId={expense.id} />}

          {/* Details */}
          <div className="rounded-xl border border-gray-200 bg-white p-5 text-sm">
            <h2 className="mb-3 font-semibold text-gray-700">Details</h2>
            <dl className="space-y-2 text-gray-600">
              <Row label="Submitted by" value={expense.user?.name ?? '—'} />
              <Row label="Created" value={new Date(expense.createdAt).toLocaleDateString()} />
              <Row label="Last updated" value={new Date(expense.updatedAt).toLocaleDateString()} />
              {expense.category && <Row label="Category" value={expense.category.name} />}
              {expense.paymentMethod && (
                <Row
                  label="Payment method"
                  value={`${expense.paymentMethod.label}${expense.paymentMethod.lastFour ? ` ···${expense.paymentMethod.lastFour}` : ''}`}
                />
              )}
              {isPrivileged && expense.reviewedBy && (
                <Row label="Reviewer" value={expense.reviewedBy.name} />
              )}
              {isPrivileged && expense.reviewedAt && (
                <Row label="Review started" value={new Date(expense.reviewedAt).toLocaleString()} />
              )}
              {isPrivileged && expense.zohoEntity && <Row label="Zoho entity" value={expense.zohoEntity} />}
              {isPrivileged && expense.zohoExpenseId && <Row label="Zoho ID" value={expense.zohoExpenseId} />}
              {expense.sourceType && <Row label="Source type" value={expense.sourceType} />}
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-gray-400 shrink-0">{label}</dt>
      <dd className="font-medium text-gray-800 text-right">{value}</dd>
    </div>
  );
}
