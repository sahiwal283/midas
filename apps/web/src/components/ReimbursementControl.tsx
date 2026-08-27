import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { accountantApi } from '../api/expenses';
import { ReimbursementBadge, REIMBURSEMENT_OPTIONS } from './StatusBadge';
import { SyncedChangeConfirm } from './SyncedChangeConfirm';
import type { ReimbursementStatus } from '../types';

function apiError(err: unknown): { code?: string; message?: string } {
  return (err as { response?: { data?: { error?: { code?: string; message?: string } } } })
    ?.response?.data?.error ?? {};
}

export function ReimbursementControl({
  expenseId,
  status,
  zohoExpenseId,
  personalCard,
  variant = 'card',
}: {
  expenseId: string;
  status: ReimbursementStatus;
  zohoExpenseId: string | null;
  personalCard?: boolean;
  variant?: 'card' | 'inline';
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ReimbursementStatus>(status);
  const [confirmSynced, setConfirmSynced] = useState(false);
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: (opts: { next: ReimbursementStatus; confirmSynced?: boolean }) =>
      accountantApi.updateReimbursement(expenseId, {
        status: opts.next,
        confirmSynced: opts.confirmSynced,
      }),
    onSuccess: () => {
      setEditing(false);
      setConfirmSynced(false);
      setError('');
      void qc.invalidateQueries({ queryKey: ['expense', expenseId] });
      void qc.invalidateQueries({ queryKey: ['expenses'] });
      void qc.invalidateQueries({ queryKey: ['accountant-queue'] });
      void qc.invalidateQueries({ queryKey: ['accountant-all'] });
      void qc.invalidateQueries({ queryKey: ['expense-audit', expenseId] });
    },
    onError: (err: unknown) => {
      const { code, message } = apiError(err);
      if (code === 'CONFIRM_SYNCED') {
        setConfirmSynced(true);
        return;
      }
      setError(message ?? 'Could not update reimbursement.');
    },
  });

  function openEditor() {
    setDraft(status);
    setConfirmSynced(false);
    setError('');
    setEditing(true);
  }

  function cancel() {
    setEditing(false);
    setConfirmSynced(false);
    setError('');
    setDraft(status);
  }

  function requestSave() {
    if (draft === status) {
      cancel();
      return;
    }
    if (zohoExpenseId && !confirmSynced) {
      setConfirmSynced(true);
      return;
    }
    mutation.mutate({ next: draft, confirmSynced: Boolean(zohoExpenseId) });
  }

  const title = `Reimbursement${personalCard ? ' (personal card)' : ''}`;
  const help = personalCard
    ? 'Personal-card expenses should move through Needs reimbursement → Approved (pending payment) → Paid.'
    : 'Change is explicit — status is not saved until you confirm.';

  const body = confirmSynced ? (
    <SyncedChangeConfirm
      fieldLabel="reimbursement"
      pending={mutation.isPending}
      onCancel={() => setConfirmSynced(false)}
      onConfirm={() => mutation.mutate({ next: draft, confirmSynced: true })}
    />
  ) : editing ? (
    <div className="space-y-2">
      <label htmlFor={`reimb-${expenseId}`} className="sr-only">
        Reimbursement status
      </label>
      <select
        id={`reimb-${expenseId}`}
        value={draft}
        disabled={mutation.isPending}
        onChange={(e) => setDraft(e.target.value as ReimbursementStatus)}
        className="w-full cursor-pointer rounded-lg border border-ink/15 px-3 py-3 text-sm focus:border-brand-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 lg:py-2"
      >
        {REIMBURSEMENT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {error && (
        <p role="alert" className="text-xs text-danger">{error}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={cancel}
          disabled={mutation.isPending}
          className="min-h-11 cursor-pointer rounded-lg border border-ink/15 px-3 py-2 text-sm text-charcoal/80 hover:bg-ink/[0.03] disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-0"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={requestSave}
          disabled={mutation.isPending || draft === status}
          className="min-h-11 cursor-pointer rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-cream hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-0"
        >
          {mutation.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  ) : (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <ReimbursementBadge status={status} showIdle />
      <button
        type="button"
        onClick={openEditor}
        className="min-h-11 cursor-pointer rounded-lg border border-ink/15 px-3 py-2 text-xs font-medium text-charcoal/80 hover:bg-ink/[0.03] lg:min-h-0"
      >
        Change
      </button>
    </div>
  );

  if (variant === 'inline') {
    return (
      <div>
        <p className="field-caption">{title}</p>
        <div className="mt-1">{body}</div>
        {editing && !confirmSynced && (
          <p className="mt-1.5 text-xs text-charcoal/40">{help}</p>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-ink/10 bg-white p-5">
      <h2 className="mb-2 text-sm font-semibold text-charcoal/80">{title}</h2>
      {body}
      {!editing && (
        <p className="mt-2 text-xs text-charcoal/40">
          {zohoExpenseId
            ? 'Already pushed to Zoho — changing reimbursement here does not update Zoho Books.'
            : help}
        </p>
      )}
    </div>
  );
}
