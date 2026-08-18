import { useState, FormEvent, ChangeEvent } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Paperclip, Send, Upload, AlertCircle, CheckCircle2,
  Clock, XCircle, RefreshCw, CreditCard, Trash2, Pencil,
} from 'lucide-react';
import { expenseApi, accountantApi } from '../api/expenses';
import { companyApi } from '../api/companies';
import { CategoryPicker } from '../components/CategoryPicker';
import { compressReceiptImage } from '../lib/receiptCompress';
import { VendorCombobox } from '../components/VendorCombobox';
import { StatusBadge, ReimbursementBadge, ZohoPushBadge, REIMBURSEMENT_OPTIONS } from '../components/StatusBadge';
import { ReceiptPreview } from '../components/ReceiptPreview';
import { ZohoSyncCard } from '../components/ZohoSyncCard';
import { useAuth } from '../contexts/AuthContext';
import type { Expense, ExpenseMessage, MessageRequestType, AuditLogEntry } from '../types';
import { roleAllowed } from '../lib/roles';

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

// ── Zoho readiness panel (accountant/admin only) ──────────────────────────────

function ZohoReadinessPanel({ expenseId }: { expenseId: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['zoho-readiness', expenseId],
    queryFn: () => expenseApi.zohoReadiness(expenseId),
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Zoho Readiness</h2>
        <p className="text-xs text-gray-400">Evaluating…</p>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Zoho Readiness</h2>
        <p className="text-xs text-red-500">Could not load readiness data.</p>
      </div>
    );
  }

  const { ready, checks, missing, warnings, zohoMode, mappedPayload } = data;
  const modeColor = zohoMode === 'live' ? 'text-red-700 bg-red-50' : zohoMode === 'dry-run' ? 'text-blue-700 bg-blue-50' : 'text-amber-700 bg-amber-50';
  const modeLabel = zohoMode === 'live' ? 'Live mode — real Zoho writes enabled' : zohoMode === 'dry-run' ? 'Dry-run mode — no live Zoho writes' : 'Mock mode — no real sync occurs';

  return (
    <div className={`rounded-xl border p-4 ${ready ? 'border-teal-200 bg-teal-50' : 'border-gray-200 bg-white'}`}>
      <h2 className="mb-1 text-sm font-semibold text-gray-700 flex items-center gap-2">
        Zoho Readiness
        {ready
          ? <span className="text-xs font-medium text-teal-700">Ready</span>
          : <span className="text-xs font-medium text-gray-400">Not ready</span>
        }
      </h2>

      <p className={`mb-3 rounded px-2 py-1 text-xs ${modeColor}`}>{modeLabel}</p>

      <ul className="space-y-1.5">
        {checks.map((c) => (
          <li key={c.label} className={`flex items-center gap-2 text-xs ${c.pass ? 'text-green-700' : 'text-red-600'}`}>
            {c.pass
              ? <CheckCircle2 className="h-3.5 w-3.5 text-green-600 shrink-0" />
              : <XCircle className="h-3.5 w-3.5 text-red-400 shrink-0" />
            }
            {c.label}
          </li>
        ))}
      </ul>

      {missing.length > 0 && (
        <div className="mt-3 rounded bg-red-50 border border-red-200 px-2 py-1.5">
          <p className="text-xs font-semibold text-red-700 mb-1">Missing:</p>
          <ul className="space-y-0.5">
            {missing.map((m) => (
              <li key={m} className="text-xs text-red-600">• {m}</li>
            ))}
          </ul>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="mt-2 space-y-1">
          {warnings.filter((w) => !w.includes('mode')).map((w) => (
            <p key={w} className="text-xs text-amber-700 bg-amber-50 rounded px-2 py-1">{w}</p>
          ))}
        </div>
      )}

      {ready && mappedPayload && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-700">
            Proposed Zoho payload (preview only)
          </summary>
          <div className="mt-2 rounded bg-gray-50 border border-gray-200 p-2 text-xs text-gray-600 space-y-1 break-words">
            <p><span className="font-medium">Merchant:</span> {mappedPayload.merchant}</p>
            <p><span className="font-medium">Amount:</span> {mappedPayload.currency} {mappedPayload.amount}</p>
            <p><span className="font-medium">Date:</span> {mappedPayload.date}</p>
            <p><span className="font-medium">Company:</span> {mappedPayload.zohoEntity}</p>
            <p><span className="font-medium">Category:</span> {mappedPayload.categoryName ?? '—'}</p>
            <p><span className="font-medium">Payment method:</span> {mappedPayload.paymentMethodLabel ?? '—'}</p>
            <p><span className="font-medium">Brand:</span> {mappedPayload.brand}</p>
            {mappedPayload.description && <p><span className="font-medium">Description:</span> {mappedPayload.description}</p>}
          </div>
        </details>
      )}

      {!ready && zohoMode !== 'live' && (
        <p className="mt-3 text-xs text-gray-400">No live Zoho write — resolve missing items above first.</p>
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
      <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-center text-xs text-gray-500 break-words">
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
        <p className={`break-words ${resolved ? 'text-green-900' : 'text-amber-900'}`}>{message.body}</p>
        {isPrivileged && message.internalNote && (
          <p className="mt-2 rounded bg-yellow-50 border border-yellow-200 px-2 py-1 text-xs text-yellow-800 break-words">
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
      <p className="break-words">{message.body}</p>
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
  'zoho.pushed': 'Pushed to Zoho',
  'zoho.failed': 'Zoho push failed',
  'zoho_entity.set': 'Company set',
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

// ── Edit details card (owner; draft/awaiting_info: all fields, pending: notes) ─

function EditDetailsCard({ expense, mode }: { expense: Expense; mode: 'all' | 'notes_only' }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    merchant: '', amount: '', date: '', description: '',
    paymentMethodId: '', company: '', categoryId: '',
  });

  // Lists for the completion fields — fetched only while the editor is open.
  const { data: paymentMethods = [] } = useQuery({
    queryKey: ['payment-methods'],
    queryFn: () => expenseApi.paymentMethods(),
    enabled: editing && mode === 'all',
  });
  const { data: companies = [] } = useQuery({
    queryKey: ['companies'],
    queryFn: () => companyApi.list(),
    enabled: editing && mode === 'all',
  });
  const { data: categories = [] } = useQuery({
    queryKey: ['expense-categories'],
    queryFn: () => expenseApi.categories(),
    enabled: editing && mode === 'all',
    staleTime: 60_000,
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      expenseApi.update(
        expense.id,
        mode === 'all'
          ? {
              merchant: form.merchant.trim(),
              amount: Number(form.amount),
              date: form.date,
              description: form.description,
              ...(form.paymentMethodId ? { paymentMethodId: form.paymentMethodId } : {}),
              ...(form.company ? { zohoEntity: form.company } : {}),
              ...(form.categoryId ? { categoryId: form.categoryId } : {}),
            }
          : { description: form.description },
      ),
    onSuccess: () => {
      setEditing(false);
      setError('');
      void qc.invalidateQueries({ queryKey: ['expense', expense.id] });
      void qc.invalidateQueries({ queryKey: ['expenses'] });
    },
    onError: (err: unknown) => {
      const apiError = (err as { response?: { data?: { error?: { code?: string; message?: string } } } })
        ?.response?.data?.error;
      setError(
        (apiError?.code === 'NOT_EDITABLE' || apiError?.code === 'PERIOD_CLOSED') && apiError.message
          ? apiError.message
          : 'Could not save changes. Please try again.',
      );
    },
  });

  function openEditor() {
    setForm({
      merchant: expense.merchant ?? '',
      amount: String(expense.amount ?? ''),
      date: expense.date ?? '',
      description: expense.description ?? '',
      paymentMethodId: expense.paymentMethodId ?? '',
      company: expense.zohoEntity ?? '',
      categoryId: expense.categoryId ?? '',
    });
    setError('');
    setEditing(true);
  }

  function handleSave(e: FormEvent) {
    e.preventDefault();
    if (mode === 'all' && (!form.merchant.trim() || !form.amount || Number(form.amount) <= 0)) {
      setError('Merchant and a valid amount are required.');
      return;
    }
    saveMutation.mutate();
  }

  const inputCls = 'w-full rounded-lg border border-gray-300 px-3 py-3 lg:py-2 text-sm focus:border-brand-500 focus:outline-none';

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">
          {mode === 'all' ? 'Edit details' : 'Edit notes'}
        </h2>
        {!editing && (
          <button
            type="button"
            onClick={openEditor}
            className="inline-flex min-h-11 items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-800 lg:min-h-0"
          >
            <Pencil className="h-3.5 w-3.5" /> Edit
          </button>
        )}
      </div>
      {!editing ? (
        <p className="text-xs text-gray-400">
          {mode === 'all'
            ? 'You can update the merchant, amount, date, payment method, company, category, and notes.'
            : 'This expense is waiting for review — only the notes can be changed.'}
        </p>
      ) : (
        <form onSubmit={handleSave} className="space-y-3">
          {mode === 'all' && (
            <>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Merchant</label>
                <VendorCombobox
                  value={form.merchant}
                  onChange={(m) => setForm((f) => ({ ...f, merchant: m }))}
                  zohoEntity={form.company || undefined}
                  inputClassName={inputCls}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">Amount</label>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    inputMode="decimal"
                    value={form.amount}
                    onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">Date</label>
                  <input
                    type="date"
                    value={form.date}
                    onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                    className={inputCls}
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Payment method</label>
                <select
                  value={form.paymentMethodId}
                  onChange={(e) => setForm((f) => ({ ...f, paymentMethodId: e.target.value }))}
                  className={inputCls}
                >
                  <option value="">— Select payment method —</option>
                  {paymentMethods.map((pm) => (
                    <option key={pm.id} value={pm.id}>
                      {pm.label}{pm.lastFour ? ` ···${pm.lastFour}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Company</label>
                <select
                  value={form.company}
                  onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
                  className={inputCls}
                >
                  <option value="">— Select company —</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.name}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Category</label>
                <CategoryPicker
                  categories={categories}
                  value={form.categoryId}
                  onChange={(id) => setForm((f) => ({ ...f, categoryId: id }))}
                />
              </div>
            </>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Notes</label>
            <textarea
              rows={2}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              className={`${inputCls} resize-none`}
            />
          </div>
          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={saveMutation.isPending}
              className="min-h-11 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-60 lg:min-h-0"
            >
              {saveMutation.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => { setEditing(false); setError(''); }}
              className="min-h-11 rounded-lg px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 lg:min-h-0"
            >
              Cancel
            </button>
          </div>
        </form>
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
  const [confirmDelete, setConfirmDelete] = useState(false);
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
    mutationFn: async (file: File) => expenseApi.uploadReceipt(id!, await compressReceiptImage(file)),
    onSuccess: () => {
      setReceiptUploadFailed(false);
      qc.invalidateQueries({ queryKey: ['expense', id] });
    },
  });

  const resolveMutation = useMutation({
    mutationFn: () => accountantApi.resolveRequest(id!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expense', id] }),
  });

  const reimbursementMutation = useMutation({
    mutationFn: (status: string) => accountantApi.updateReimbursement(id!, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['expense', id] });
      qc.invalidateQueries({ queryKey: ['expense-audit', id] });
    },
  });

  const zohoRetryMutation = useMutation({
    mutationFn: () => accountantApi.pushToZoho(id!),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['expense', id] });
      qc.invalidateQueries({ queryKey: ['expense-audit', id] });
      qc.invalidateQueries({ queryKey: ['zoho-readiness', id] });
    },
  });

  const cloneMutation = useMutation({
    mutationFn: () => expenseApi.clone(id!),
    onSuccess: (clone) => {
      void qc.invalidateQueries({ queryKey: ['expenses'] });
      navigate(`/expenses/${clone.id}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => expenseApi.delete(id!, Boolean(expense?.zohoExpenseId)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['expenses'] });
      void qc.invalidateQueries({ queryKey: ['accountant-queue'] });
      navigate('/expenses');
    },
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
  const isPrivileged = roleAllowed(user?.role, ['accountant', 'admin']);
  const canSeeZohoSync = roleAllowed(user?.role, ['accountant', 'admin']);
  const isDraft = expense.status === 'draft';
  const isAwaiting = expense.status === 'awaiting_info';
  const isRejected = expense.status === 'rejected';
  // Rejection reason: the most recent accountant (non-owner) or system message.
  const rejectionReason = (() => {
    if (!isRejected) return null;
    const msgs = expense.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.isSystem || m.senderId !== expense.userId) return m.body;
    }
    return null;
  })();
  // Field editing mirrors the API's state rules: draft/awaiting_info/pending
  // fully editable (pending so submitters can complete missing fields before
  // review), everything else (incl. Zoho-synced) locked.
  const editMode: 'all' | 'notes_only' | 'none' = (() => {
    if (!isOwner || expense.zohoExpenseId) return 'none';
    if (isDraft || isAwaiting || expense.status === 'pending') return 'all';
    return 'none';
  })();
  // What a pending daily expense still needs to auto-approve without an
  // accountant. Mirrors the server's Zoho readiness checks the owner can fix.
  // Partner expenses never sit in 'pending' (recorded as approved on submit),
  // so pending + daily source is a sufficient guard here.
  const missingForAutoPush: string[] = (() => {
    if (!isOwner || expense.status !== 'pending') return [];
    if (expense.sourceApp && expense.sourceApp !== 'browser_extension') return [];
    const missing: string[] = [];
    if (!(expense.receipts?.length)) missing.push('a receipt');
    if (!expense.paymentMethodId) missing.push('a payment method');
    if (!expense.categoryId && !expense.zohoExpenseAccountId) missing.push('a category');
    if (!expense.zohoEntity) missing.push('a company');
    return missing;
  })();
  const hasOpenRequest = expense.messages?.some(
    (m) => m.requestType && !m.isResolved,
  ) ?? false;
  const canDelete = (() => {
    if (expense.zohoExpenseId) return roleAllowed(user?.role, ['admin']);
    if (isPrivileged) return true;
    if (!isOwner) return false;
    return expense.status === 'draft' || (expense.status === 'pending' && !expense.reviewedAt);
  })();

  return (
    <div className="p-4 lg:p-8">
      {/* Header */}
      <div className="mb-4 flex items-start gap-3 pr-8 lg:gap-4 lg:pr-0">
        <button onClick={() => navigate(-1)} className="mt-0.5 flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded p-1 text-gray-400 hover:bg-gray-100 lg:min-h-0 lg:min-w-0">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="min-w-0 max-w-full break-words text-2xl font-bold text-gray-900">{expense.merchant}</h1>
            <StatusBadge
              status={expense.status}
              variant={isPrivileged ? 'accountant' : 'user'}
              zohoExpenseId={expense.zohoExpenseId}
            />
            {expense.reimbursementStatus !== 'not_requested' && (
              <ReimbursementBadge status={expense.reimbursementStatus} />
            )}
            {isPrivileged && (
              <ZohoPushBadge
                zohoExpenseId={expense.zohoExpenseId}
                syncFailed={expense.status === 'zoho_sync_failed'}
              />
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
        <div className="flex flex-col items-end gap-2">
          <p className="text-2xl font-bold text-gray-900">
            {expense.currency} {Number(expense.amount).toFixed(2)}
          </p>
          {canDelete && !confirmDelete && (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-red-200 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 lg:min-h-0"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </button>
          )}
          {canDelete && confirmDelete && (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate()}
                className="min-h-11 rounded-lg bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50 lg:min-h-0"
              >
                {deleteMutation.isPending ? 'Deleting…' : 'Confirm delete'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="min-h-11 rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 lg:min-h-0"
              >
                Cancel
              </button>
            </div>
          )}
          {deleteMutation.isError && (
            <p className="max-w-xs text-right text-xs font-medium text-red-600">
              {(deleteMutation.error as { response?: { data?: { error?: { message?: string } } } })
                ?.response?.data?.error?.message ?? 'Could not delete this expense.'}
            </p>
          )}
        </div>
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

      {/* Rejected — reason + corrected-expense action (owner only) */}
      {isOwner && isRejected && (
        <div className="mb-6 rounded-xl border-2 border-red-300 bg-red-50 p-4">
          <div className="flex items-start gap-3">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-red-900">Rejected</p>
              <p className="mt-0.5 text-sm text-red-800">
                {rejectionReason ?? 'See the conversation below.'}
              </p>
              <button
                type="button"
                onClick={() => cloneMutation.mutate()}
                disabled={cloneMutation.isPending}
                className="mt-3 min-h-11 w-full rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60 sm:w-auto lg:min-h-0"
              >
                {cloneMutation.isPending ? 'Creating…' : 'Create corrected expense'}
              </button>
              {cloneMutation.isError && (
                <p className="mt-2 text-xs text-red-700">
                  Could not create the corrected expense. Please try again.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Status banner — user-facing only (the owner's rejected card replaces it).
          An incomplete pending daily expense gets an actionable checklist instead
          of the generic "waiting for review" banner. */}
      {missingForAutoPush.length > 0 ? (
        <div className="mb-6 rounded-xl border-2 border-amber-400 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">
            Almost done — add {missingForAutoPush.join(', ')} to finish this expense.
          </p>
          <p className="mt-1 text-sm text-amber-800">
            Once complete it will be approved and sent to accounting automatically — no
            accountant review needed. Use the Receipts card below or the Edit details card.
          </p>
        </div>
      ) : (
        !isPrivileged && !(isOwner && isRejected) && (
          <StatusBanner status={expense.status} isPrivileged={false} />
        )
      )}

      {/* Action-needed callout for users */}
      {isOwner && isAwaiting && (
        <div className="mb-6 rounded-xl border-2 border-amber-400 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">Your accountant is waiting for your reply.</p>
          <p className="mt-1 text-sm text-amber-800">Scroll down to the conversation and reply to unblock your expense.</p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Main column */}
        <div className="space-y-6 lg:col-span-2">
          {expense.description && (
            <div className="rounded-xl border border-gray-200 bg-white p-5">
              <h2 className="mb-2 text-sm font-semibold text-gray-700">Description</h2>
              <p className="break-words text-sm text-gray-600">{expense.description}</p>
            </div>
          )}

          {/* Receipts */}
          <div id="receipts" className="scroll-mt-6 rounded-xl border border-gray-200 bg-white p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-700">Receipts</h2>
              {(isOwner || isPrivileged) && (
                <label className="flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 lg:min-h-0">
                  <Upload className="h-3.5 w-3.5" />
                  {uploadMutation.isPending ? 'Uploading…' : 'Upload'}
                  <input type="file" accept="image/*,.pdf" className="hidden" onChange={handleFileChange} />
                </label>
              )}
            </div>
            {expense.receipts && expense.receipts.length > 0 ? (
              <div className="space-y-2">
                {expense.receipts.map((r) => (
                  <div key={r.id} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2.5 space-y-2">
                    <div className="flex items-center gap-2">
                      <Paperclip className="h-4 w-4 shrink-0 text-gray-400" />
                      <span className="flex-1 truncate text-sm text-gray-700">{r.filename}</span>
                      <span className={`text-xs font-medium ${
                        r.ocrStatus === 'done' ? 'text-green-600' :
                        r.ocrStatus === 'failed' ? 'text-red-500' :
                        r.ocrStatus === 'processing' ? 'text-blue-500' :
                        'text-gray-400'
                      }`}>
                        {isPrivileged
                          ? `OCR: ${r.ocrStatus}`
                          : r.ocrStatus === 'done' ? 'Receipt scan complete'
                          : r.ocrStatus === 'failed' ? 'Receipt scan needs review'
                          : r.ocrStatus === 'processing' ? 'Receipt scan in progress'
                          : 'Receipt scan pending'}
                      </span>
                    </div>
                    {isPrivileged && r.ocrProvider && (
                      <div className="pl-6 space-y-0.5">
                        <p className="text-xs text-gray-500">
                          Provider: <span className="font-medium">{r.ocrProvider}</span>
                          {r.ocrOverallConfidence != null && (
                            <> · Confidence: <span className="font-medium">{Math.round(Number(r.ocrOverallConfidence) * 100)}%</span></>
                          )}
                        </p>
                        {r.ocrNeedsReview && (
                          <p className="text-xs font-medium text-amber-700">
                            Suggested: needs review{r.ocrReviewReasons?.length ? ` — ${r.ocrReviewReasons.join(', ')}` : ''}
                          </p>
                        )}
                        {r.ocrStatus === 'failed' && r.ocrErrorSummary && (
                          <p className="text-xs text-red-600">{r.ocrErrorSummary}</p>
                        )}
                      </div>
                    )}
                    <ReceiptPreview expenseId={expense.id} receipt={r} />
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
                  className="min-h-11 text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50 lg:min-h-0"
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
                className={`min-w-0 flex-1 rounded-lg border px-3 py-3 text-sm focus:outline-none lg:py-2 ${
                  isAwaiting && isOwner
                    ? 'border-amber-300 bg-amber-50 focus:border-amber-500'
                    : 'border-gray-300 focus:border-brand-500'
                }`}
              />
              <button
                type="submit"
                disabled={!message.trim() || messageMutation.isPending}
                className="min-h-11 min-w-11 rounded-lg bg-brand-600 px-3 py-2 text-white hover:bg-brand-700 disabled:opacity-60 lg:min-h-0 lg:min-w-0"
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
                className="min-h-11 w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60 lg:min-h-0"
              >
                {submitMutation.isPending ? 'Submitting…' : 'Submit for Review'}
              </button>
              {submitMutation.isError && (
                <p className="mt-2 text-xs font-medium text-red-600">
                  {(submitMutation.error as { response?: { data?: { error?: { message?: string } } } })
                    ?.response?.data?.error?.message ?? 'Could not submit this expense.'}
                </p>
              )}
              <p className="mt-2 text-xs text-gray-400">Once submitted, your accountant will review this expense.</p>
            </div>
          )}

          {/* Field editing — owner only, gated by the API's state rules */}
          {editMode !== 'none' && (
            <EditDetailsCard expense={expense} mode={editMode} />
          )}

          {/* Reimbursement — accountant/admin only */}
          {isPrivileged && (
            <div className="rounded-xl border border-gray-200 bg-white p-5">
              <h2 className="mb-2 text-sm font-semibold text-gray-700">
                Reimbursement
                {expense.paymentMethod?.requiresReimbursement || /personal/i.test(expense.paymentMethod?.label ?? '')
                  ? ' — personal card'
                  : ''}
              </h2>
              <select
                value={expense.reimbursementStatus}
                disabled={reimbursementMutation.isPending}
                onChange={(e) => reimbursementMutation.mutate(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-3 text-sm focus:border-brand-500 focus:outline-none disabled:opacity-60 lg:py-2"
              >
                {REIMBURSEMENT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <p className="mt-2 text-xs text-gray-400">
                Personal-card expenses should move through Needs reimbursement → Approved (pending payment) → Paid.
              </p>
            </div>
          )}

          {/* Zoho readiness — accountant/admin only */}
          {isPrivileged && (
            <ZohoReadinessPanel expenseId={expense.id} />
          )}

          {/* Zoho sync history — accountant/admin/developer only */}
          {canSeeZohoSync && (
            <ZohoSyncCard
              expense={expense}
              // developer passes every role gate server-side, so retry works for them too
              onRetry={canSeeZohoSync ? () => zohoRetryMutation.mutate() : undefined}
              retrying={zohoRetryMutation.isPending}
            />
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
              {(expense.zohoExpenseAccountName || expense.category) && (
                <Row
                  label="Expense account"
                  value={expense.zohoExpenseAccountName ?? expense.category?.name ?? '—'}
                />
              )}
              {expense.zohoEntity && <Row label="Company" value={expense.zohoEntity} />}
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
              {expense.sourceApp && <Row label="Source app" value={expense.sourceApp} />}
              {expense.sourceRefId && <Row label="Source ref" value={expense.sourceRefId} />}
              {expense.sourceLabel && <Row label="Source label" value={expense.sourceLabel} />}
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
    <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4">
      <dt className="text-gray-400 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 break-words font-medium text-gray-800 sm:text-right">{value}</dd>
    </div>
  );
}
