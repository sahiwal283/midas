import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Plus, ReceiptText, AlertCircle, CheckCircle2, Clock, RefreshCw, FileX, Banknote, ChevronRight } from 'lucide-react';
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
        <h1 className="text-2xl font-bold text-gray-900">
          {timeGreeting()}, {name.split(' ')[0]}
        </h1>
        <p className="mt-1 text-sm text-gray-500">Here&apos;s what needs your attention today</p>
      </div>

      {/* Queue overview */}
      <div className="mb-6 rounded-xl border border-gray-200 bg-white">
        <div className="border-b border-gray-200 px-6 py-4">
          <h2 className="font-semibold text-gray-900">Review Queues</h2>
        </div>
        {isLoading ? (
          <div className="px-6 py-8 text-center text-sm text-gray-400">Loading…</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {rows.map((row) => (
              <Link
                key={row.label}
                to={row.to}
                className="flex items-center justify-between px-6 py-4 hover:bg-gray-50"
              >
                <div className="flex items-center gap-3">
                  {row.icon}
                  <span className="text-sm font-medium text-gray-900">{row.label}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`rounded-full px-2.5 py-0.5 text-sm font-semibold ${
                    row.count > 0 ? 'bg-yellow-100 text-yellow-800' : 'bg-gray-100 text-gray-500'
                  }`}>
                    {row.count}
                  </span>
                  <ChevronRight className="h-4 w-4 text-gray-300" />
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
          className="rounded-xl border border-teal-200 bg-teal-50 p-5 transition-colors hover:bg-teal-100"
        >
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-teal-800">Ready for Zoho</p>
            <CheckCircle2 className="h-5 w-5 text-teal-600" />
          </div>
          <p className="mt-2 text-3xl font-bold text-teal-900">
            {fmtMoney(summary?.readyForZohoAmount ?? 0)}
          </p>
          <p className="mt-1 text-xs text-teal-700">
            {counts.ready_for_zoho ?? 0} expense{(counts.ready_for_zoho ?? 0) !== 1 ? 's' : ''} ready to push
          </p>
        </Link>
        <Link
          to="/accountant?status=reimbursement_pending"
          className="rounded-xl border border-orange-200 bg-orange-50 p-5 transition-colors hover:bg-orange-100"
        >
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-orange-800">Awaiting Reimbursement</p>
            <Banknote className="h-5 w-5 text-orange-600" />
          </div>
          <p className="mt-2 text-3xl font-bold text-orange-900">
            {fmtMoney(summary?.reimbursementPendingAmount ?? 0)}
          </p>
          <p className="mt-1 text-xs text-orange-700">
            {summary?.reimbursementEmployees ?? 0} employee{(summary?.reimbursementEmployees ?? 0) !== 1 ? 's' : ''} waiting
          </p>
        </Link>
      </div>
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
          <h1 className="text-2xl font-bold text-gray-900">Welcome, {user?.name?.split(' ')[0]}</h1>
          <p className="mt-1 text-sm text-gray-500">Here's an overview of your expenses</p>
        </div>
        <Link
          to="/expenses/new"
          className="flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          <Plus className="h-4 w-4" />
          New Expense
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

      {/* Action-first: what needs you, then what's in flight */}
      <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
        <StatCard label="Needs your attention" value={actionNeeded.length} icon={<AlertCircle className={`h-5 w-5 ${actionNeeded.length > 0 ? 'text-amber-600' : 'text-gray-300'}`} />} />
        <StatCard label="Under Review" value={inFlight.length} icon={<ReceiptText className="h-5 w-5 text-yellow-600" />} />
        <StatCard label="Approved" value={approved.length} icon={<CheckCircle2 className="h-5 w-5 text-green-600" />} />
      </div>

      {/* Recent expenses */}
      <div className="rounded-xl border border-gray-200 bg-white">
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <h2 className="font-semibold text-gray-900">Recent Expenses</h2>
          <Link to="/expenses" className="text-sm text-brand-600 hover:text-brand-700">View all</Link>
        </div>

        {isLoading ? (
          <div className="px-6 py-8 text-center text-sm text-gray-400">Loading…</div>
        ) : recent.length === 0 ? (
          <div className="px-6 py-8 text-center text-sm text-gray-400">
            No expenses yet.{' '}
            <Link to="/expenses/new" className="text-brand-600 hover:underline">Create one</Link>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {recent.map((expense) => (
              <Link
                key={expense.id}
                to={`/expenses/${expense.id}`}
                className={`flex items-center justify-between px-6 py-4 hover:bg-gray-50 ${expense.status === 'awaiting_info' ? 'bg-amber-50' : ''}`}
              >
                <div>
                  <p className="font-medium text-gray-900">{expense.merchant}</p>
                  <p className="text-sm text-gray-500">
                    {expense.date} · {expense.category?.name ?? 'Uncategorized'}
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <span className="font-semibold text-gray-900">
                    {expense.currency} {Number(expense.amount).toFixed(2)}
                  </span>
                  <div className="w-36 text-right">
                    {expense.status === 'awaiting_info' ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-200 px-2.5 py-0.5 text-xs font-semibold text-amber-900">
                        <AlertCircle className="h-3 w-3" />
                        Action needed
                      </span>
                    ) : (
                      <span className="text-xs text-gray-500">{userStatusLabel(expense.status, expense.zohoExpenseId)}</span>
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

function StatCard({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">{label}</p>
        {icon}
      </div>
      <p className="mt-2 text-3xl font-bold text-gray-900">{value}</p>
    </div>
  );
}
