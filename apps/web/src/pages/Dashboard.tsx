import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Plus, ReceiptText, AlertCircle, CheckCircle2, Clock, RefreshCw, FileX, Banknote, ChevronRight, Lock } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { expenseApi, accountantApi } from '../api/expenses';
import { userStatusLabel } from '../components/StatusBadge';
import { ConfirmModal } from '../components/ConfirmModal';

function fmtMoney(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function timeGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export function Dashboard() {
  const { user } = useAuth();
  // Accountants get a queue-first dashboard; everyone else keeps the standard one.
  if (user?.role === 'accountant') return <AccountantDashboard name={user.name} />;
  return <EmployeeDashboard />;
}

// ── Accountant dashboard ──────────────────────────────────────────────────────

function AccountantDashboard({ name }: { name: string }) {
  const { data: summary, isLoading } = useQuery({
    queryKey: ['accountant-queue-summary'],
    queryFn: () => accountantApi.queueSummary(),
  });

  const counts = summary?.counts ?? {};
  const rows = [
    {
      label: 'Needs Review',
      count: (counts.pending ?? 0) + (counts.in_review ?? 0),
      to: '/accountant?status=needs_review',
      icon: <Clock className="h-4 w-4 text-yellow-600" />,
    },
    {
      label: 'Awaiting User',
      count: counts.awaiting_info ?? 0,
      to: '/accountant?status=awaiting_user',
      icon: <AlertCircle className="h-4 w-4 text-amber-600" />,
    },
    {
      label: 'Zoho Failed',
      count: counts.zoho_sync_failed ?? 0,
      to: '/accountant?status=zoho_failed',
      icon: <RefreshCw className="h-4 w-4 text-red-600" />,
    },
    {
      label: 'Missing Fields',
      count: (counts.needs_category ?? 0) + (counts.missing_receipt ?? 0) + (counts.needs_payment_method ?? 0),
      to: '/accountant',
      icon: <FileX className="h-4 w-4 text-orange-600" />,
    },
  ];

  return (
    <div className="p-4 lg:p-8">
      <div className="mb-8">
        <h1 className="font-display text-3xl font-semibold text-ink">
          {timeGreeting()}, {name.split(' ')[0]}
        </h1>
        <p className="mt-1 text-sm text-charcoal/55">Here&apos;s what needs your attention today</p>
      </div>

      {/* Queue overview */}
      <div className="mb-6 rounded-xl border border-ink/10 bg-white shadow-panel">
        <div className="border-b border-ink/10 px-6 py-4">
          <h2 className="font-display text-lg font-semibold text-ink">Review Queues</h2>
        </div>
        {isLoading ? (
          <div className="px-6 py-8 text-center text-sm text-charcoal/40">Loading…</div>
        ) : (
          <div className="divide-y divide-ink/5">
            {rows.map((row) => (
              <Link
                key={row.label}
                to={row.to}
                className="flex items-center justify-between px-6 py-4 hover:bg-cream/80"
              >
                <div className="flex items-center gap-3">
                  {row.icon}
                  <span className="text-sm font-medium text-ink">{row.label}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`rounded-md px-2.5 py-0.5 text-sm font-semibold ${
                    row.count > 0 ? 'bg-brand-500/15 text-brand-800' : 'bg-ink/5 text-charcoal/50'
                  }`}>
                    {row.count}
                  </span>
                  <ChevronRight className="h-4 w-4 text-charcoal/25" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Money-in-motion stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Link
          to="/accountant?status=ready_for_zoho"
          className="rounded-xl border border-success/25 bg-success/5 p-5 transition-colors hover:bg-success/10"
        >
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-success">Ready for Zoho</p>
            <CheckCircle2 className="h-5 w-5 text-success" />
          </div>
          <p className="mt-2 font-display text-3xl font-semibold text-ink">
            {fmtMoney(summary?.readyForZohoAmount ?? 0)}
          </p>
          <p className="mt-1 text-xs text-success/80">
            {counts.ready_for_zoho ?? 0} expense{(counts.ready_for_zoho ?? 0) !== 1 ? 's' : ''} ready to push
          </p>
        </Link>
        <Link
          to="/accountant?reimbursementStatus=pending"
          className="rounded-xl border border-brand-500/30 bg-brand-500/5 p-5 transition-colors hover:bg-brand-500/10"
        >
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-brand-800">Awaiting Reimbursement</p>
            <Banknote className="h-5 w-5 text-brand-600" />
          </div>
          <p className="mt-2 font-display text-3xl font-semibold text-ink">
            {fmtMoney(summary?.reimbursementPendingAmount ?? 0)}
          </p>
          <p className="mt-1 text-xs text-brand-700/80">
            {summary?.reimbursementEmployees ?? 0} employee{(summary?.reimbursementEmployees ?? 0) !== 1 ? 's' : ''} waiting
          </p>
        </Link>
      </div>

      {/* Closed accounting periods */}
      <div className="mt-6">
        <ClosedPeriodsCard />
      </div>
    </div>
  );
}

// ── Closed accounting periods card ────────────────────────────────────────────

function fmtPeriod(period: string): string {
  const [y, m] = period.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function ClosedPeriodsCard() {
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
    <div className="rounded-xl border border-gray-200 bg-white">
      <div className="flex items-center gap-2 border-b border-gray-200 px-6 py-4">
        <Lock className="h-4 w-4 text-gray-500" />
        <h2 className="font-semibold text-gray-900">Closed Periods</h2>
      </div>
      <div className="px-6 py-4">
        <p className="mb-3 text-xs text-gray-500">
          Expenses dated in a closed month are locked — no edits, deletes, submissions, reviews, or
          reimbursement changes. Corrections go through a new expense in an open month.
        </p>

        {error && (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="mb-4 flex items-center gap-2">
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900"
            aria-label="Month to close"
          />
          <button
            type="button"
            disabled={!month || closeMutation.isPending}
            onClick={() => setConfirmClose(true)}
            className="rounded-lg bg-brand-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            Close period
          </button>
        </div>

        {isLoading ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : periods.length === 0 ? (
          <p className="text-sm text-gray-400">No closed periods yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {periods.map((p) => (
              <li key={p.period} className="flex items-center justify-between py-2">
                <div>
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
                    className="text-xs font-medium text-red-500 hover:text-red-700 disabled:opacity-50"
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

// ── Employee dashboard (unchanged behavior) ───────────────────────────────────

function EmployeeDashboard() {
  const { user } = useAuth();

  const { data: expenses = [], isLoading } = useQuery({
    queryKey: ['expenses'],
    queryFn: () => expenseApi.list(),
  });

  const actionNeeded = expenses.filter((e) => e.status === 'awaiting_info');
  const inFlight = expenses.filter((e) => e.status === 'pending' || e.status === 'in_review');
  const approved = expenses.filter((e) => e.status === 'approved' || e.status === 'zoho_sync_failed');
  const recent = [...expenses].slice(0, 5);

  return (
    <div className="p-4 lg:p-8">
      <div className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="font-display text-3xl font-semibold text-ink">
            {timeGreeting()}, {user?.name?.split(' ')[0]}
          </h1>
          <p className="mt-1 text-sm text-charcoal/55">
            {actionNeeded.length > 0
              ? `${actionNeeded.length} expense${actionNeeded.length === 1 ? '' : 's'} need${actionNeeded.length === 1 ? 's' : ''} your attention`
              : 'Here\u2019s what needs you next'}
          </p>
        </div>
        <Link
          to="/expenses/new"
          className="flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-cream hover:bg-brand-600"
        >
          <Plus className="h-4 w-4" />
          Add Transaction
        </Link>
      </div>

      {/* Action-needed callout */}
      {actionNeeded.length > 0 && (
        <div className="mb-6 rounded-xl border-2 border-amber-400 bg-amber-50 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            <div className="flex-1">
              <p className="font-semibold text-amber-900">
                {actionNeeded.length === 1
                  ? 'Your accountant has a question about one expense.'
                  : `Your accountant has questions about ${actionNeeded.length} expenses.`}
              </p>
              <div className="mt-2 space-y-1">
                {actionNeeded.map((e) => (
                  <Link
                    key={e.id}
                    to={`/expenses/${e.id}`}
                    className="flex items-center justify-between rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900 hover:bg-amber-200"
                  >
                    <span className="font-medium">{e.merchant}</span>
                    <span className="text-xs opacity-70">Reply →</span>
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Action-first lanes */}
      <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
        <StatCard
          label="Needs your attention"
          value={actionNeeded.length}
          accent={actionNeeded.length > 0}
          icon={<AlertCircle className={`h-5 w-5 ${actionNeeded.length > 0 ? 'text-amber-600' : 'text-charcoal/30'}`} />}
        />
        <StatCard
          label="Under review"
          value={inFlight.length}
          icon={<ReceiptText className="h-5 w-5 text-brand-600" />}
        />
        <StatCard
          label="Approved"
          value={approved.length}
          icon={<CheckCircle2 className="h-5 w-5 text-success" />}
        />
      </div>

      {/* Recent expenses */}
      <div className="rounded-xl border border-ink/10 bg-white shadow-panel">
        <div className="flex items-center justify-between border-b border-ink/10 px-6 py-4">
          <h2 className="font-display text-lg font-semibold text-ink">Recent expenses</h2>
          <Link to="/expenses" className="text-sm font-medium text-brand-700 hover:text-brand-800">View all</Link>
        </div>

        {isLoading ? (
          <div className="px-6 py-8 text-center text-sm text-charcoal/40">Loading…</div>
        ) : recent.length === 0 ? (
          <div className="px-6 py-8 text-center text-sm text-charcoal/45">
            No expenses yet.{' '}
            <Link to="/expenses/new" className="text-brand-700 hover:underline">Create one</Link>
          </div>
        ) : (
          <div className="divide-y divide-ink/5">
            {recent.map((expense) => (
              <Link
                key={expense.id}
                to={`/expenses/${expense.id}`}
                className={`flex items-center justify-between px-6 py-4 hover:bg-ink/[0.02] ${expense.status === 'awaiting_info' ? 'bg-amber-50/80' : ''}`}
              >
                <div>
                  <p className="font-medium text-ink">{expense.merchant}</p>
                  <p className="text-sm text-charcoal/50">
                    {expense.date} · {expense.category?.name ?? 'Uncategorized'}
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <span className="font-semibold text-ink">
                    {expense.currency} {Number(expense.amount).toFixed(2)}
                  </span>
                  <div className="w-40 text-right">
                    {expense.status === 'awaiting_info' ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-200 px-2.5 py-0.5 text-xs font-semibold text-amber-900">
                        <AlertCircle className="h-3 w-3" />
                        Action needed
                      </span>
                    ) : (
                      <span className="text-xs font-medium text-charcoal/60">
                        {userStatusLabel(expense.status, expense.zohoExpenseId)}
                      </span>
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Closed accounting periods — admins/developers manage (incl. reopen) */}
      {(user?.role === 'admin' || user?.role === 'developer') && (
        <div className="mt-6">
          <ClosedPeriodsCard />
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  accent = false,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <div className={`rounded-xl border bg-white p-5 shadow-panel ${accent ? 'border-amber-400/60' : 'border-ink/10'}`}>
      <div className="flex items-center justify-between">
        <p className="text-sm text-charcoal/55">{label}</p>
        {icon}
      </div>
      <p className="mt-2 font-display text-3xl font-semibold text-ink">{value}</p>
    </div>
  );
}
