import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ExternalLink, Eye, EyeOff, Trash2 } from 'lucide-react';
import { accountantApi, expenseApi } from '../api/expenses';
import {
  StatusBadge,
  ReimbursementBadge,
  ZohoPushBadge,
} from './StatusBadge';
import { Modal } from './Modal';
import { ConfirmModal } from './ConfirmModal';
import { ReceiptPreview } from './ReceiptPreview';
import { ReimbursementControl } from './ReimbursementControl';
import { CategoryRecode } from './CategoryRecode';
import { ReferenceNumberField } from './ReferenceNumberField';
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

  const footer = (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <div>
        {del.allowed && (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="btn-danger-quiet"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </button>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onClose} className="btn-secondary">
          Close
        </button>
        {expense && (
          <Link to={`/expenses/${expense.id}`} className="btn-primary" onClick={onClose}>
            Open full page
            <ExternalLink className="h-4 w-4" />
          </Link>
        )}
      </div>
    </div>
  );

  return (
    <>
      <Modal
        open
        onClose={onClose}
        size="xl"
        tone="navy"
        title="Expense Details"
        subtitle={expense?.sourceLabel || expense?.merchant || 'Loading…'}
        footer={footer}
        bodyClassName="px-5 py-5 sm:px-6"
      >
        {isLoading && <ExpenseSkeleton />}
        {error && (
          <p role="alert" className="text-sm text-danger">
            Could not load this expense.
          </p>
        )}

        {expense && (
          <div className="space-y-5">
            {/* ── Facts ─────────────────────────────────────────────── */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-4">
              <Field label="Date" value={expense.date} />
              <Field
                label="Amount"
                value={`${expense.currency} ${Number(expense.amount).toFixed(2)}`}
                emphasis
              />
              <Field label="Merchant" value={expense.merchant} />
              <Field
                label="Card used"
                value={
                  expense.paymentMethod
                    ? `${expense.paymentMethod.label}${expense.paymentMethod.lastFour ? ` (···${expense.paymentMethod.lastFour})` : ''}`
                    : '—'
                }
              />
              <Field label="Submitted by" value={expense.user?.name ?? '—'} />
              {!isPrivileged && <Field label="Category" value={expense.category?.name ?? '—'} />}
            </div>

            {/* ── Editable / long-form ──────────────────────────────── */}
            {(isPrivileged || expense.referenceNumber || expense.description) && (
              <div className="divide-y divide-ink/[0.07] overflow-hidden rounded-xl border border-ink/10">
                {isPrivileged && (
                  <div className="px-4 py-3">
                    <ReferenceNumberField
                      expenseId={expense.id}
                      value={expense.referenceNumber}
                      zohoExpenseId={expense.zohoExpenseId}
                      variant="inline"
                    />
                  </div>
                )}

                {isPrivileged && (
                  <div className="px-4 py-3">
                    <CategoryRecode
                      expenseId={expense.id}
                      categoryId={expense.categoryId}
                      categoryName={expense.category?.name ?? expense.zohoExpenseAccountName ?? null}
                      zohoExpenseId={expense.zohoExpenseId}
                      variant="inline"
                    />
                  </div>
                )}

                {!isPrivileged && expense.referenceNumber && (
                  <div className="px-4 py-3">
                    <p className="field-caption">Reference number</p>
                    <p className="field-value">{expense.referenceNumber}</p>
                  </div>
                )}

                {expense.description && (
                  <div className="px-4 py-3">
                    <p className="field-caption">Description</p>
                    <p className="field-value whitespace-pre-wrap text-charcoal/80">
                      {expense.description}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* ── Status ────────────────────────────────────────────── */}
            <div className="overflow-hidden rounded-xl border border-ink/10 bg-cream">
              <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-3">
                <div>
                  <p className="field-caption">Approval</p>
                  <div className="mt-1.5">
                    <StatusBadge status={expense.status} variant="accountant" />
                  </div>
                </div>
                <div>
                  <p className="field-caption">Zoho</p>
                  <div className="mt-1.5">
                    <ZohoPushBadge
                      zohoExpenseId={expense.zohoExpenseId}
                      syncFailed={expense.status === 'zoho_sync_failed'}
                    />
                    {expense.zohoExpenseId && (
                      <p className="mt-1 font-mono text-[10px] text-charcoal/45">
                        {expense.zohoExpenseId}
                      </p>
                    )}
                  </div>
                </div>
                <div className="col-span-2 sm:col-span-1">
                  <p className="field-caption">Company</p>
                  <p className="field-value">{expense.zohoEntity ?? '—'}</p>
                </div>
              </div>

              <div className="border-t border-ink/[0.07] p-4">
                {isPrivileged ? (
                  <ReimbursementControl
                    expenseId={expense.id}
                    status={expense.reimbursementStatus as ReimbursementStatus}
                    zohoExpenseId={expense.zohoExpenseId}
                    personalCard={personalCard}
                    variant="inline"
                  />
                ) : (
                  <>
                    <p className="field-caption">Reimbursement</p>
                    <div className="mt-1.5">
                      <ReimbursementBadge
                        status={expense.reimbursementStatus as ReimbursementStatus}
                        showIdle
                      />
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* ── Review actions ────────────────────────────────────── */}
            {isPrivileged && canReview && (
              <div className="rounded-xl border border-gold-400/50 bg-gold-50 p-3">
                <p className="field-caption mb-2 text-gold-800">Review this expense</p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={reviewMutation.isPending}
                    onClick={() => reviewMutation.mutate('approve')}
                    className="btn-primary"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={reviewMutation.isPending}
                    onClick={() => reviewMutation.mutate('reject')}
                    className="btn-danger"
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    disabled={reviewMutation.isPending}
                    onClick={() => reviewMutation.mutate('request_info')}
                    className="btn-secondary"
                  >
                    Needs further review
                  </button>
                </div>
              </div>
            )}

            {/* ── Receipt ───────────────────────────────────────────── */}
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="field-caption">
                  Receipt{receipts.length > 1 ? `s (${receipts.length})` : ''}
                </p>
                {receipts.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowReceipt((v) => !v)}
                    aria-expanded={showReceipt}
                    className="btn-ghost gap-1.5 text-xs"
                  >
                    {showReceipt ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    {showReceipt ? 'Hide' : 'Show'}
                  </button>
                )}
              </div>

              {receipts.length === 0 ? (
                <div className="rounded-xl border border-dashed border-ink/15 bg-cream px-4 py-6 text-center">
                  <p className="text-sm text-muted">No receipt attached.</p>
                </div>
              ) : (
                <>
                  {receipts.length > 1 && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {receipts.map((r, i) => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => setReceiptIndex(i)}
                          aria-current={i === receiptIndex}
                          aria-label={`Receipt ${i + 1} of ${receipts.length}`}
                          className={`h-8 min-w-8 rounded-lg px-2.5 text-xs font-semibold transition-colors duration-150 ${
                            i === receiptIndex
                              ? 'bg-brand-500 text-cream'
                              : 'bg-brand-50 text-charcoal/70 hover:bg-brand-100'
                          }`}
                        >
                          {i + 1}
                        </button>
                      ))}
                    </div>
                  )}
                  {showReceipt && activeReceipt && (
                    <div className="rounded-xl border border-ink/10 bg-cream p-3">
                      <ReceiptPreview
                        expenseId={expense.id}
                        receipt={activeReceipt}
                        className="max-h-[20rem]"
                      />
                      <p className="mt-2 truncate text-center text-[11px] text-muted">
                        {activeReceipt.filename} · opens full size in a new tab
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={confirmDelete}
        title="Delete this expense?"
        danger
        confirmLabel="Delete permanently"
        loading={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
        onCancel={() => setConfirmDelete(false)}
      >
        {del.needsForce
          ? 'This expense is already linked to Zoho. Deleting it here removes the Midas record permanently and will not remove it from Zoho Books.'
          : 'This permanently removes the expense and its receipts. This cannot be undone.'}
      </ConfirmModal>
    </>
  );
}

function Field({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="field-caption">{label}</p>
      <p className={emphasis ? 'mt-1 text-base font-semibold tabular-nums text-ink' : 'field-value break-words'}>
        {value}
      </p>
    </div>
  );
}

/** Placeholder that matches the loaded layout, so the modal doesn't resize under the user. */
function ExpenseSkeleton() {
  return (
    <div className="animate-pulse space-y-5" aria-hidden="true">
      <div className="grid grid-cols-2 gap-x-4 gap-y-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i}>
            <div className="h-2.5 w-20 rounded bg-ink/10" />
            <div className="mt-2 h-4 w-32 rounded bg-ink/[0.07]" />
          </div>
        ))}
      </div>
      <div className="h-24 rounded-xl bg-ink/[0.05]" />
      <div className="h-40 rounded-xl bg-ink/[0.05]" />
    </div>
  );
}
