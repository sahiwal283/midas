import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Eye, EyeOff, Trash2, X } from 'lucide-react';
import { accountantApi, expenseApi } from '../api/expenses';
import {
  StatusBadge,
  ReimbursementBadge,
  ZohoPushBadge,
  REIMBURSEMENT_OPTIONS,
} from './StatusBadge';
import { ReceiptPreview } from './ReceiptPreview';
import { useAuth } from '../contexts/AuthContext';
import type { Expense, ReimbursementStatus } from '../types';

function canDeleteExpense(expense: Expense, role: string | undefined, userId: string | undefined): {
  allowed: boolean;
  needsForce: boolean;
} {
  if (!role || !userId) return { allowed: false, needsForce: false };
  const isOwner = expense.userId === userId;
  const isPrivileged = role === 'accountant' || role === 'admin';
  if (!isOwner && !isPrivileged) return { allowed: false, needsForce: false };

  if (expense.zohoExpenseId) {
    return { allowed: role === 'admin', needsForce: true };
  }
  if (isPrivileged) return { allowed: true, needsForce: false };
  if (expense.status === 'draft') return { allowed: true, needsForce: false };
  if (expense.status === 'pending' && !expense.reviewedAt) return { allowed: true, needsForce: false };
  return { allowed: false, needsForce: false };
}

export function ExpenseQuickViewModal({
  expenseId,
  onClose,
  onDeleted,
}: {
  expenseId: string;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [showReceipt, setShowReceipt] = useState(true);
  const [receiptIndex, setReceiptIndex] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isPrivileged = user?.role === 'accountant' || user?.role === 'admin';

  const { data: expense, isLoading, error } = useQuery({
    queryKey: ['expense', expenseId],
    queryFn: () => expenseApi.get(expenseId),
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    setReceiptIndex(0);
    setConfirmDelete(false);
    setShowReceipt(true);
  }, [expenseId]);

  function invalidate() {
    void qc.invalidateQueries({ queryKey: ['expense', expenseId] });
    void qc.invalidateQueries({ queryKey: ['expenses'] });
    void qc.invalidateQueries({ queryKey: ['accountant-queue'] });
    void qc.invalidateQueries({ queryKey: ['accountant-all'] });
  }

  const deleteMutation = useMutation({
    mutationFn: () => {
      const force = Boolean(expense?.zohoExpenseId);
      return expenseApi.delete(expenseId, force);
    },
    onSuccess: () => {
      invalidate();
      onDeleted?.();
      onClose();
    },
  });

  const reviewMutation = useMutation({
    mutationFn: (action: 'approve' | 'reject' | 'request_info') =>
      accountantApi.review(expenseId, {
        action,
        note: action === 'request_info' ? 'Please provide more information.' : undefined,
        requestType: action === 'request_info' ? 'info_request' : undefined,
      }),
    onSuccess: () => invalidate(),
  });

  const reimbursementMutation = useMutation({
    mutationFn: (status: string) => accountantApi.updateReimbursement(expenseId, { status }),
    onSuccess: () => invalidate(),
  });

  const del = expense ? canDeleteExpense(expense, user?.role, user?.id) : { allowed: false, needsForce: false };
  const receipts = expense?.receipts ?? [];
  const activeReceipt = receipts[receiptIndex] ?? receipts[0];
  const canReview = expense
    && (expense.status === 'pending' || expense.status === 'in_review' || expense.status === 'awaiting_info');
  const personalCard = Boolean(expense?.paymentMethod?.requiresReimbursement)
    || /personal/i.test(expense?.paymentMethod?.label ?? '');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="expense-quick-view-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-xl">
        <div className="flex items-start justify-between gap-3 bg-emerald-700 px-5 py-4 text-white">
          <div className="min-w-0">
            <h2 id="expense-quick-view-title" className="text-lg font-semibold">
              Expense Details
            </h2>
            <p className="mt-0.5 truncate text-sm text-emerald-100">
              {expense?.sourceLabel || expense?.merchant || 'Loading…'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-white/90 hover:bg-white/10"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
          {error && <p className="text-sm text-red-600">Could not load expense.</p>}
          {expense && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Date" value={expense.date} />
                <Field label="Amount" value={`${expense.currency} ${Number(expense.amount).toFixed(2)}`} />
                <Field label="Merchant" value={expense.merchant} />
                <Field label="Category" value={expense.category?.name ?? '—'} />
                <Field
                  label="Card used"
                  value={
                    expense.paymentMethod
                      ? `${expense.paymentMethod.label}${expense.paymentMethod.lastFour ? ` (···${expense.paymentMethod.lastFour})` : ''}`
                      : '—'
                  }
                />
                <Field label="Submitted by" value={expense.user?.name ?? '—'} />
              </div>

              {expense.description && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Description</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-gray-700">{expense.description}</p>
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Approval</p>
                  <div className="mt-1">
                    <StatusBadge status={expense.status} variant="accountant" />
                  </div>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Zoho</p>
                  <div className="mt-1">
                    <ZohoPushBadge
                      zohoExpenseId={expense.zohoExpenseId}
                      syncFailed={expense.status === 'zoho_sync_failed'}
                    />
                    {expense.zohoExpenseId && (
                      <p className="mt-0.5 font-mono text-[10px] text-gray-400">{expense.zohoExpenseId}</p>
                    )}
                  </div>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Company</p>
                  <p className="mt-1 text-sm text-gray-800">{expense.zohoEntity ?? '—'}</p>
                </div>
              </div>

              {isPrivileged ? (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                    Reimbursement{personalCard ? ' (personal card)' : ''}
                  </p>
                  <select
                    value={expense.reimbursementStatus}
                    disabled={reimbursementMutation.isPending}
                    onChange={(e) => reimbursementMutation.mutate(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none disabled:opacity-60"
                  >
                    {REIMBURSEMENT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
              ) : (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Reimbursement</p>
                  <div className="mt-1">
                    <ReimbursementBadge status={expense.reimbursementStatus as ReimbursementStatus} showIdle />
                  </div>
                </div>
              )}

              {isPrivileged && canReview && (
                <div className="flex flex-wrap gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <button
                    type="button"
                    disabled={reviewMutation.isPending}
                    onClick={() => reviewMutation.mutate('approve')}
                    className="rounded-lg bg-green-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={reviewMutation.isPending}
                    onClick={() => reviewMutation.mutate('reject')}
                    className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    disabled={reviewMutation.isPending}
                    onClick={() => reviewMutation.mutate('request_info')}
                    className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                  >
                    Needs further review
                  </button>
                </div>
              )}

              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                    Receipt{receipts.length > 1 ? `s (${receipts.length})` : ''}
                  </p>
                  {receipts.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowReceipt((v) => !v)}
                      className="inline-flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-gray-900"
                    >
                      {showReceipt ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      {showReceipt ? 'Hide' : 'Show'}
                    </button>
                  )}
                </div>
                {receipts.length === 0 && (
                  <p className="text-sm text-gray-400">No receipt attached.</p>
                )}
                {receipts.length > 1 && (
                  <div className="mb-2 flex flex-wrap gap-1">
                    {receipts.map((r, i) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => setReceiptIndex(i)}
                        className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                          i === receiptIndex
                            ? 'bg-gray-900 text-white'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                      >
                        {i + 1}
                      </button>
                    ))}
                  </div>
                )}
                {showReceipt && activeReceipt && (
                  <ReceiptPreview expenseId={expense.id} receipt={activeReceipt} />
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 bg-gray-50 px-5 py-3">
          <div>
            {del.allowed && !confirmDelete && (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </button>
            )}
            {del.allowed && confirmDelete && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-red-700">
                  {del.needsForce
                    ? 'Zoho-linked — permanently delete?'
                    : 'Delete this expense permanently?'}
                </span>
                <button
                  type="button"
                  disabled={deleteMutation.isPending}
                  onClick={() => deleteMutation.mutate()}
                  className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {deleteMutation.isPending ? 'Deleting…' : 'Confirm'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-200"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Close
            </button>
            {expense && (
              <Link
                to={`/expenses/${expense.id}`}
                className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700"
                onClick={onClose}
              >
                Open full page
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-0.5 text-sm text-gray-900">{value}</p>
    </div>
  );
}
