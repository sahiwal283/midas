import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { accountantApi } from '../api/expenses';

function apiError(err: unknown): { code?: string; message?: string } {
  return (err as { response?: { data?: { error?: { code?: string; message?: string } } } })
    ?.response?.data?.error ?? {};
}

const inputCls = 'w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink placeholder:text-charcoal/40 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

/** Accountant inline editor for the Zoho Reference Number (receipt / invoice #). */
export function ReferenceNumberField({
  expenseId,
  value,
  zohoExpenseId,
  variant = 'card',
}: {
  expenseId: string;
  value: string | null | undefined;
  zohoExpenseId: string | null;
  variant?: 'card' | 'inline';
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [error, setError] = useState('');
  const locked = Boolean(zohoExpenseId);

  const mutation = useMutation({
    mutationFn: (next: string | null) =>
      accountantApi.updateReferenceNumber(expenseId, next),
    onSuccess: () => {
      setEditing(false);
      setError('');
      void qc.invalidateQueries({ queryKey: ['expense', expenseId] });
      void qc.invalidateQueries({ queryKey: ['expenses'] });
      void qc.invalidateQueries({ queryKey: ['accountant-queue'] });
      void qc.invalidateQueries({ queryKey: ['accountant-all'] });
      void qc.invalidateQueries({ queryKey: ['expense-audit', expenseId] });
      void qc.invalidateQueries({ queryKey: ['zoho-readiness', expenseId] });
    },
    onError: (err: unknown) => {
      setError(apiError(err).message ?? 'Could not update reference number.');
    },
  });

  function openEditor() {
    setDraft(value ?? '');
    setError('');
    setEditing(true);
  }

  function save() {
    const next = draft.trim() || null;
    if (next === (value?.trim() || null)) {
      setEditing(false);
      return;
    }
    mutation.mutate(next);
  }

  const wrapCls = variant === 'inline' ? '' : 'rounded-xl border border-ink/10 bg-white p-5';

  return (
    <div className={wrapCls}>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">Reference number</p>
      {editing ? (
        <div className="mt-2 space-y-2">
          <input
            autoFocus
            maxLength={50}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') setEditing(false);
            }}
            placeholder="Receipt #, invoice #, sales order…"
            className={inputCls}
          />
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={mutation.isPending}
              onClick={save}
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-cream hover:bg-brand-700 disabled:opacity-60"
            >
              {mutation.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => { setEditing(false); setError(''); }}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-charcoal/70 hover:bg-brand-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-1 flex items-center justify-between gap-2">
          <p className="text-sm text-ink">{value?.trim() || '—'}</p>
          {!locked && (
            <button
              type="button"
              onClick={openEditor}
              className="shrink-0 text-xs font-medium text-brand-600 hover:text-brand-800"
            >
              {value?.trim() ? 'Edit' : 'Add'}
            </button>
          )}
        </div>
      )}
      <p className="mt-1 text-xs text-charcoal/40">
        {locked
          ? 'Already in Zoho — kept in Midas only.'
          : 'Receipt #, invoice #, sales order… sent to Zoho as Reference Number.'}
      </p>
    </div>
  );
}
