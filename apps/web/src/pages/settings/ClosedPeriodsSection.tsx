import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { accountantApi } from '../../api/expenses';
import { ConfirmModal } from '../../components/ConfirmModal';
import { useAuth } from '../../contexts/AuthContext';

function fmtPeriod(period: string): string {
  const [y, m] = period.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/**
 * Month-end close. Closing 'YYYY-MM' locks every expense dated in that month
 * against edits, deletes, submissions, reviews and reimbursement changes
 * (enforced API-side; admin force-delete is the audited override).
 * Reopening is admin-only.
 */
export function ClosedPeriodsSection() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const canReopen = user?.role === 'admin' || user?.role === 'developer';

  const [month, setMonth] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  const [reopenTarget, setReopenTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: periods = [], isLoading } = useQuery({
    queryKey: ['closed-periods'],
    queryFn: () => accountantApi.closedPeriods(),
  });

  const closeMutation = useMutation({
    mutationFn: () => accountantApi.closePeriod(month),
    onSuccess: () => {
      setConfirmClose(false);
      setMonth('');
      setError(null);
      qc.invalidateQueries({ queryKey: ['closed-periods'] });
    },
    onError: (err: any) => {
      setConfirmClose(false);
      setError(err?.response?.data?.error?.message ?? 'Could not close the period');
    },
  });

  const reopenMutation = useMutation({
    mutationFn: (period: string) => accountantApi.reopenPeriod(period),
    onSuccess: () => {
      setReopenTarget(null);
      setError(null);
      qc.invalidateQueries({ queryKey: ['closed-periods'] });
    },
    onError: (err: any) => {
      setReopenTarget(null);
      setError(err?.response?.data?.error?.message ?? 'Could not reopen the period');
    },
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">
        Close a month once its books are final. Expenses dated in a closed month are locked — no
        edits, deletes, submissions, reviews, or reimbursement changes. Corrections go through a new
        expense in an open month.
      </p>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-3 text-sm text-gray-900 focus:border-brand-500 focus:outline-none lg:py-2"
          aria-label="Month to close"
        />
        <button
          type="button"
          disabled={!month || closeMutation.isPending}
          onClick={() => setConfirmClose(true)}
          className="min-h-11 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50 lg:min-h-0"
        >
          Close period
        </button>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white">
        {isLoading ? (
          <p className="px-5 py-4 text-sm text-gray-400">Loading…</p>
        ) : periods.length === 0 ? (
          <p className="px-5 py-4 text-sm text-gray-400">
            No closed periods yet — every month is open.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {periods.map((p) => (
              <li key={p.period} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <span className="text-sm font-medium text-gray-900">{fmtPeriod(p.period)}</span>
                  <span className="ml-2 text-xs text-gray-400">
                    closed {new Date(p.createdAt).toLocaleDateString()}
                    {p.closedBy?.name ? ` by ${p.closedBy.name}` : ''}
                  </span>
                  {p.note && <p className="text-xs text-gray-500">{p.note}</p>}
                </div>
                {canReopen && (
                  <button
                    type="button"
                    onClick={() => setReopenTarget(p.period)}
                    disabled={reopenMutation.isPending}
                    className="min-h-11 shrink-0 px-2 text-xs font-medium text-red-500 hover:text-red-700 disabled:opacity-50 lg:min-h-0 lg:px-0"
                  >
                    Reopen
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmModal
        open={confirmClose}
        title={`Close ${month ? fmtPeriod(month) : 'period'}?`}
        confirmLabel="Close period"
        loading={closeMutation.isPending}
        onConfirm={() => closeMutation.mutate()}
        onCancel={() => setConfirmClose(false)}
      >
        Every expense dated in {month ? fmtPeriod(month) : 'this month'} will be locked against
        edits, deletes, submissions, reviews, and reimbursement changes.
      </ConfirmModal>

      <ConfirmModal
        open={reopenTarget !== null}
        title={`Reopen ${reopenTarget ? fmtPeriod(reopenTarget) : 'period'}?`}
        confirmLabel="Reopen period"
        danger
        loading={reopenMutation.isPending}
        onConfirm={() => reopenTarget && reopenMutation.mutate(reopenTarget)}
        onCancel={() => setReopenTarget(null)}
      >
        Expenses in this month become editable and reviewable again. The action is audited.
      </ConfirmModal>
    </div>
  );
}
