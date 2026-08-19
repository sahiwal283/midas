import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { accountantApi, expenseApi } from '../api/expenses';
import { CategoryPicker } from './CategoryPicker';
import { SyncedChangeConfirm } from './SyncedChangeConfirm';

function apiError(err: unknown): { code?: string; message?: string } {
  return (err as { response?: { data?: { error?: { code?: string; message?: string } } } })
    ?.response?.data?.error ?? {};
}

export function CategoryRecode({
  expenseId,
  categoryId,
  categoryName,
  zohoExpenseId,
  variant = 'card',
}: {
  expenseId: string;
  categoryId: string | null;
  categoryName: string | null;
  zohoExpenseId: string | null;
  variant?: 'card' | 'inline';
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(categoryId ?? '');
  const [confirmSynced, setConfirmSynced] = useState(false);
  const [error, setError] = useState('');

  const { data: categories = [] } = useQuery({
    queryKey: ['expense-categories'],
    queryFn: () => expenseApi.categories(),
    enabled: editing,
    staleTime: 60_000,
  });

  const mutation = useMutation({
    mutationFn: (opts: { next: string; confirmSynced?: boolean }) =>
      accountantApi.updateCategory(expenseId, {
        categoryId: opts.next,
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
      void qc.invalidateQueries({ queryKey: ['zoho-readiness', expenseId] });
    },
    onError: (err: unknown) => {
      const { code, message } = apiError(err);
      if (code === 'CONFIRM_SYNCED') {
        setConfirmSynced(true);
        return;
      }
      setError(message ?? 'Could not update category.');
    },
  });

  function openEditor() {
    setDraft(categoryId ?? '');
    setConfirmSynced(false);
    setError('');
    setEditing(true);
  }

  function cancel() {
    setEditing(false);
    setConfirmSynced(false);
    setError('');
    setDraft(categoryId ?? '');
  }

  function requestSave() {
    if (!draft || draft === (categoryId ?? '')) {
      cancel();
      return;
    }
    if (zohoExpenseId && !confirmSynced) {
      setConfirmSynced(true);
      return;
    }
    mutation.mutate({ next: draft, confirmSynced: Boolean(zohoExpenseId) });
  }

  const display = categoryName ?? '—';

  const body = confirmSynced ? (
    <SyncedChangeConfirm
      fieldLabel="category"
      pending={mutation.isPending}
      onCancel={() => setConfirmSynced(false)}
      onConfirm={() => mutation.mutate({ next: draft, confirmSynced: true })}
    />
  ) : editing ? (
    <div className="space-y-2">
      <label htmlFor={`cat-${expenseId}`} className="sr-only">Category</label>
      {categories.length === 0 ? (
        <p className="text-xs text-gray-400">Loading categories…</p>
      ) : (
        <CategoryPicker
          id={`cat-${expenseId}`}
          categories={categories}
          value={draft}
          onChange={setDraft}
          placeholder="Search categories…"
          disabled={mutation.isPending}
        />
      )}
      {error && (
        <p role="alert" className="text-xs text-red-600">{error}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={cancel}
          disabled={mutation.isPending}
          className="min-h-11 cursor-pointer rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-0"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={requestSave}
          disabled={mutation.isPending || !draft || draft === (categoryId ?? '')}
          className="min-h-11 cursor-pointer rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-0"
        >
          {mutation.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  ) : (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-gray-800">{display}</p>
      <button
        type="button"
        onClick={openEditor}
        className="min-h-11 cursor-pointer rounded-lg border border-gray-300 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 lg:min-h-0"
      >
        Change
      </button>
    </div>
  );

  if (variant === 'inline') {
    return (
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Category</p>
        <div className="mt-1">{body}</div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <h2 className="mb-2 text-sm font-semibold text-gray-700">Category</h2>
      {body}
      {!editing && zohoExpenseId && (
        <p className="mt-2 text-xs text-gray-400">
          Already pushed to Zoho — recategorizing here does not update Zoho Books.
        </p>
      )}
    </div>
  );
}
