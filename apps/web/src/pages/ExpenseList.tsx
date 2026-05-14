import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Plus, AlertCircle } from 'lucide-react';
import { expenseApi } from '../api/expenses';
import { StatusBadge } from '../components/StatusBadge';
import type { Expense } from '../types';

const NEXT_ACTION: Record<string, { text: string; urgent: boolean }> = {
  draft: { text: 'Submit for review', urgent: false },
  pending: { text: 'Waiting for accountant', urgent: false },
  in_review: { text: 'Being reviewed', urgent: false },
  awaiting_info: { text: 'Reply to accountant', urgent: true },
  approved: { text: 'Approved', urgent: false },
  zoho_sync_failed: { text: 'Processing', urgent: false },
  rejected: { text: 'Rejected — see messages', urgent: false },
};

function NextActionCell({ expense }: { expense: Expense }) {
  const action = NEXT_ACTION[expense.status];
  if (!action) return <span className="text-gray-400">—</span>;

  if (action.urgent) {
    return (
      <Link to={`/expenses/${expense.id}`} className="flex items-center gap-1 text-amber-700 font-medium hover:underline">
        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
        {action.text}
      </Link>
    );
  }
  return <span className="text-gray-500">{action.text}</span>;
}

export function ExpenseList() {
  const { data: expenses = [], isLoading } = useQuery({
    queryKey: ['expenses'],
    queryFn: () => expenseApi.list(),
  });

  const actionNeeded = expenses.filter((e) => e.status === 'awaiting_info').length;

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">My Expenses</h1>
          {actionNeeded > 0 && (
            <p className="mt-1 flex items-center gap-1 text-sm font-medium text-amber-700">
              <AlertCircle className="h-4 w-4" />
              {actionNeeded} expense{actionNeeded !== 1 ? 's' : ''} need{actionNeeded === 1 ? 's' : ''} your reply
            </p>
          )}
        </div>
        <Link
          to="/expenses/new"
          className="flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          <Plus className="h-4 w-4" />
          New Expense
        </Link>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white">
        {isLoading ? (
          <div className="px-6 py-12 text-center text-sm text-gray-400">Loading…</div>
        ) : expenses.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-gray-500">No expenses yet.</p>
            <Link to="/expenses/new" className="mt-2 inline-block text-sm text-brand-600 hover:underline">
              Create your first expense
            </Link>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                <th className="px-6 py-3">Merchant</th>
                <th className="px-6 py-3">Date</th>
                <th className="px-6 py-3">Category</th>
                <th className="px-6 py-3 text-right">Amount</th>
                <th className="px-6 py-3">Status</th>
                <th className="px-6 py-3">Next action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {expenses.map((expense) => (
                <tr key={expense.id} className={`hover:bg-gray-50 ${expense.status === 'awaiting_info' ? 'bg-amber-50' : ''}`}>
                  <td className="px-6 py-4">
                    <Link to={`/expenses/${expense.id}`} className="font-medium text-gray-900 hover:text-brand-700">
                      {expense.merchant}
                    </Link>
                    {expense.description && (
                      <p className="mt-0.5 text-xs text-gray-400 line-clamp-1">{expense.description}</p>
                    )}
                    {expense.sourceApp === 'browser_extension' && (
                      <span className="mt-0.5 inline-block rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700">Extension</span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-gray-600">{expense.date}</td>
                  <td className="px-6 py-4 text-gray-600">{expense.category?.name ?? '—'}</td>
                  <td className="px-6 py-4 text-right font-medium text-gray-900">
                    {expense.currency} {Number(expense.amount).toFixed(2)}
                  </td>
                  <td className="px-6 py-4">
                    <StatusBadge status={expense.status} variant="user" />
                  </td>
                  <td className="px-6 py-4 text-sm">
                    <NextActionCell expense={expense} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
