import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Plus, ReceiptText, AlertCircle, CheckCircle2, Clock, RefreshCw, FileX, Banknote } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { expenseApi, accountantApi } from '../api/expenses';
import { userStatusLabel } from '../components/StatusBadge';

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
  const byScope = summary?.byScope;
  const scoped = (pick: (c: Record<string, number>) => number) => ({
    event: byScope ? pick(byScope.event.counts) : 0,
    daily: byScope ? pick(byScope.daily.counts) : 0,
  });

  const rows = [
    {
      label: 'Needs Review',
      count: (counts.pending ?? 0) + (counts.in_review ?? 0),
      per: scoped((c) => (c.pending ?? 0) + (c.in_review ?? 0)),
      query: 'status=needs_review',
      icon: <Clock className="h-4 w-4 text-yellow-600" />,
    },
    {
      label: 'Awaiting User',
      count: counts.awaiting_info ?? 0,
      per: scoped((c) => c.awaiting_info ?? 0),
      query: 'status=awaiting_user',
      icon: <AlertCircle className="h-4 w-4 text-amber-600" />,
    },
    {
      label: 'Zoho Failed',
      count: counts.zoho_sync_failed ?? 0,
      per: scoped((c) => c.zoho_sync_failed ?? 0),
      query: 'status=zoho_failed',
      icon: <RefreshCw className="h-4 w-4 text-red-600" />,
    },
    {
      label: 'Missing Fields',
      count: (counts.needs_category ?? 0) + (counts.missing_receipt ?? 0) + (counts.needs_payment_method ?? 0),
      per: scoped((c) => (c.needs_category ?? 0) + (c.missing_receipt ?? 0) + (c.needs_payment_method ?? 0)),
      query: '',
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
        <div className="border-b border-gold-400/60 px-6 py-4">
          <h2 className="font-display text-lg font-semibold text-ink">Review Queues</h2>
        </div>
        {isLoading ? (
          <div className="px-6 py-8 text-center text-sm text-charcoal/40">Loading…</div>
        ) : (
          <div className="divide-y divide-ink/5">
            {rows.map((row) => (
              <div
                key={row.label}
                className="flex items-center justify-between px-6 py-4"
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
                  <div className="flex items-center gap-2">
                    <Link
                      to={`/accountant/events${row.query ? `?${row.query}` : ''}`}
                      className="rounded-md bg-ink/5 px-2 py-0.5 text-xs font-medium text-charcoal/70 hover:bg-ink/10 hover:text-ink"
                    >
                      {row.per.event} event
                    </Link>
                    <Link
                      to={`/accountant/daily${row.query ? `?${row.query}` : ''}`}
                      className="rounded-md bg-ink/5 px-2 py-0.5 text-xs font-medium text-charcoal/70 hover:bg-ink/10 hover:text-ink"
                    >
                      {row.per.daily} daily
                    </Link>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Money-in-motion stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-success/25 bg-success/5 p-5">
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
          <div className="mt-3 flex items-center gap-2">
            <Link
              to="/accountant/events?status=ready_for_zoho"
              className="rounded-md bg-ink/5 px-2 py-0.5 text-xs font-medium text-charcoal/70 hover:bg-ink/10 hover:text-ink"
            >
              {fmtMoney(byScope?.event.readyForZohoAmount ?? 0)} event
            </Link>
            <Link
              to="/accountant/daily?status=ready_for_zoho"
              className="rounded-md bg-ink/5 px-2 py-0.5 text-xs font-medium text-charcoal/70 hover:bg-ink/10 hover:text-ink"
            >
              {fmtMoney(byScope?.daily.readyForZohoAmount ?? 0)} daily
            </Link>
          </div>
        </div>
        <div className="rounded-xl border border-brand-500/30 bg-brand-500/5 p-5">
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
          <div className="mt-3 flex items-center gap-2">
            <Link
              to="/accountant/events?reimbursementStatus=pending"
              className="rounded-md bg-ink/5 px-2 py-0.5 text-xs font-medium text-charcoal/70 hover:bg-ink/10 hover:text-ink"
            >
              {fmtMoney(byScope?.event.reimbursementPendingAmount ?? 0)} event
            </Link>
            <Link
              to="/accountant/daily?reimbursementStatus=pending"
              className="rounded-md bg-ink/5 px-2 py-0.5 text-xs font-medium text-charcoal/70 hover:bg-ink/10 hover:text-ink"
            >
              {fmtMoney(byScope?.daily.reimbursementPendingAmount ?? 0)} daily
            </Link>
          </div>
        </div>
      </div>

    </div>
  );
}

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
      {/* The bell floats top-right on mobile, so keep the greeting clear of it;
          the Add button is desktop-only \u2014 the camera FAB covers mobile. */}
      <div className="mb-6 flex items-start justify-between pr-10 lg:mb-8 lg:pr-0">
        <div>
          <h1 className="font-display text-2xl font-semibold text-ink lg:text-3xl">
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
          className="hidden items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-cream hover:bg-brand-600 lg:flex"
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

      {/* Action-first lanes — compact 3-up on phones instead of stacked slabs */}
      <div className="mb-6 grid grid-cols-3 gap-2 sm:gap-4 lg:mb-8">
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
        <div className="flex items-center justify-between border-b border-gold-400/60 px-4 py-4 sm:px-6">
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
                className={`flex items-start justify-between gap-3 px-4 py-3 hover:bg-ink/[0.02] sm:items-center sm:px-6 sm:py-4 ${expense.status === 'awaiting_info' ? 'bg-amber-50/80' : ''}`}
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink">{expense.merchant}</p>
                  <p className="truncate text-sm text-charcoal/50">
                    {expense.date} · {expense.category?.name ?? 'Uncategorized'}
                  </p>
                </div>
                {/* Phone: amount over status, right-aligned. Desktop: side by side. */}
                <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-4">
                  <span className="font-semibold text-ink">
                    {expense.currency} {Number(expense.amount).toFixed(2)}
                  </span>
                  <div className="text-right sm:w-40">
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
    <div className={`rounded-xl border bg-white p-3 shadow-panel sm:p-5 ${accent ? 'border-amber-400/60' : 'border-ink/10'}`}>
      <div className="flex items-center justify-between gap-1">
        <p className="text-xs leading-tight text-charcoal/55 sm:text-sm">{label}</p>
        <span className="hidden sm:block">{icon}</span>
      </div>
      <p className="mt-1.5 font-display text-2xl font-semibold text-ink sm:mt-2 sm:text-3xl">{value}</p>
    </div>
  );
}
