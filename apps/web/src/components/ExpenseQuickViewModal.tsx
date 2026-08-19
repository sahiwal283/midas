import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Eye, EyeOff, Trash2, X } from 'lucide-react';
import { accountantApi, expenseApi } from '../api/expenses';
import {
  StatusBadge,
  ReimbursementBadge,
  ZohoPushBadge,
} from './StatusBadge';
import { ReceiptPreview } from './ReceiptPreview';
import { ReimbursementControl } from './ReimbursementControl';
import { CategoryRecode } from './CategoryRecode';
import { useAuth } from '../contexts/AuthContext';
import type { Expense, ReimbursementStatus } from '../types';
import type { UserRole } from '@midas/shared';
import { roleAllowed } from '../lib/roles';

function canDeleteExpense(expense: Expense, role: string | undefined, userId: string | undefined): {
  allowed: boolean;
  needsForce: boolean;
} {
  if (!role || !userId) return { allowed: false, needsForce: false };
  const isOwner = expense.userId === userId;
  const isPrivileged = roleAllowed(role as UserRole, ['accountant', 'admin']);
  if (!isOwner && !isPrivileged) return { allowed: false, needsForce: false };

  if (expense.zohoExpenseId) {
    return { allowed: roleAllowed(role as UserRole, ['admin']), needsForce: true };
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
  const isPrivileged = roleAllowed(user?.role, ['accountant', 'admin']);

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

  const del = expense ? canDeleteExpense(expense, user?.role, user?.id) : { allowed: false, needsForce: false };
  const receipts = expense?.receipts ?? [];
  const activeReceipt = receipts[receiptIndex] ?? receipts[0];
  const canReview = expense
    && (expense.status === 'pending' || expense.status === 'in_review' || expense.status === 'awaiting_info');
  const personalCard = Boolean(expense?.paymentMethod?.requiresReimbursement)
    || /personal/i.test(expense?.paymentMethod?.label ?? '');

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="expense-quick-view-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[92dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl bg-white pb-[env(safe-area-inset-bottom)] shadow-xl sm:rounded-xl sm:pb-0">
        <div className="flex items-start justify-between gap-3 border-b border-gold-400/60 bg-brand-800 px-5 py-4 text-cream">
          <div className="min-w-0">
            <h2 id="expense-quick-view-title" className="text-lg font-semibold">
              Expense Details
            </h2>
            <p className="mt-0.5 truncate text-sm text-brand-200">
              {expense?.sourceLabel || expense?.merchant || 'Loading…'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-cream/90 hover:bg-white/10"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {isLoading && <p className="text-sm text-muted">Loading…</p>}
          {error && <p className="text-sm text-danger">Could not load expense.</p>}
          {expense && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Date" value={expense.date} />
                <Field label="Amount" value={`${expense.currency} ${Number(expense.amount).toFixed(2)}`} />
                <Field label="Merchant" value={expense.merchant} />
                {!isPrivileged && (
                  <Field label="Category" value={expense.category?.name ?? '—'} />
                )}
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

              {isPrivileged && (
                <CategoryRecode
                  expenseId={expense.id}
                  categoryId={expense.categoryId}
                  categoryName={expense.category?.name ?? expense.zohoExpenseAccountName ?? null}
                  zohoExpenseId={expense.zohoExpenseId}
                  variant="inline"
                />
              )}

              {expense.description && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">Description</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-charcoal/80">{expense.description}</p>
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">Approval</p>
                  <div className="mt-1">
                    <StatusBadge status={expense.status} variant="accountant" />
                  </div>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">Zoho</p>
                  <div className="mt-1">
                    <ZohoPushBadge
                      zohoExpenseId={expense.zohoExpenseId}
                      syncFailed={expense.status === 'zoho_sync_failed'}
                    />
                    {expense.zohoExpenseId && (
                      <p className="mt-0.5 font-mono text-[10px] text-charcoal/40">{expense.zohoExpenseId}</p>
                    )}
                  </div>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">Company</p>
                  <p className="mt-1 text-sm text-ink">{expense.zohoEntity ?? '—'}</p>
                </div>
              </div>

              {isPrivileged ? (
                <ReimbursementControl
                  expenseId={expense.id}
                  status={expense.reimbursementStatus as ReimbursementStatus}
                  zohoExpenseId={expense.zohoExpenseId}
                  personalCard={personalCard}
                  variant="inline"
                />
              ) : (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">Reimbursement</p>
                  <div className="mt-1">
                    <ReimbursementBadge status={expense.reimbursementStatus as ReimbursementStatus} showIdle />
                  </div>
                </div>
              )}

              {isPrivileged && canReview && (
                <div className="flex flex-wrap gap-2 rounded-lg border border-ink/10 bg-cream p-3">
                  <button
                    type="button"
                    disabled={reviewMutation.isPending}
                    onClick={() => reviewMutation.mutate('approve')}
                    className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-cream hover:bg-success disabled:opacity-50"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={reviewMutation.isPending}
                    onClick={() => reviewMutation.mutate('reject')}
                    className="rounded-lg bg-danger px-3 py-1.5 text-sm font-semibold text-cream hover:bg-danger disabled:opacity-50"
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
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                    Receipt{receipts.length > 1 ? `s (${receipts.length})` : ''}
                  </p>
                  {receipts.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowReceipt((v) => !v)}
                      className="inline-flex items-center gap-1 text-xs font-medium text-charcoal/70 hover:text-ink"
                    >
                      {showReceipt ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      {showReceipt ? 'Hide' : 'Show'}
                    </button>
                  )}
                </div>
                {receipts.length === 0 && (
                  <p className="text-sm text-charcoal/40">No receipt attached.</p>
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
                            ? 'bg-ink text-cream'
                            : 'bg-brand-50 text-charcoal/70 hover:bg-ink/[0.08]'
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

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink/5 bg-cream px-5 py-3">
          <div>
            {del.allowed && !confirmDelete && (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-danger hover:bg-danger/10"
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </button>
            )}
            {del.allowed && confirmDelete && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-danger">
                  {del.needsForce
                    ? 'Zoho-linked — permanently delete?'
                    : 'Delete this expense permanently?'}
                </span>
                <button
                  type="button"
                  disabled={deleteMutation.isPending}
                  onClick={() => deleteMutation.mutate()}
                  className="rounded-lg bg-danger px-3 py-1.5 text-xs font-semibold text-cream hover:bg-danger disabled:opacity-50"
                >
                  {deleteMutation.isPending ? 'Deleting…' : 'Confirm'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-charcoal/70 hover:bg-ink/[0.08]"
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
              className="rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm font-medium text-charcoal/80 hover:bg-ink/[0.03]"
            >
              Close
            </button>
            {expense && (
              <Link
                to={`/expenses/${expense.id}`}
                className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-cream hover:bg-brand-700"
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
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-0.5 text-sm text-ink">{value}</p>
    </div>
  );
}
