import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Plus, AlertCircle } from 'lucide-react';
import { expenseApi } from '../api/expenses';
import { ExpenseBrowser } from '../components/ExpenseBrowser';
import { PageHeader } from '../components/PageHeader';

/**
 * The employee's own submissions, for every role — the company-wide list
 * lives on the accountant review pages under the Queue/All toggle.
 */
export function MyExpenses() {
  const qc = useQueryClient();
  const { data: expenses = [], isLoading } = useQuery({
    queryKey: ['expenses'],
    queryFn: () => expenseApi.list(),
  });

  const actionNeeded = expenses.filter((e) => e.status === 'awaiting_info').length;

  return (
    <div className="page">
      <PageHeader
        title="My Expenses"
        subtitle={
          actionNeeded > 0 ? (
            <span className="flex items-center gap-1 font-medium text-amber-800">
              <AlertCircle className="h-4 w-4" />
              {actionNeeded} expense{actionNeeded !== 1 ? 's' : ''} need{actionNeeded === 1 ? 's' : ''} your reply
            </span>
          ) : undefined
        }
        actions={
          <Link to="/transactions/new" className="btn-primary">
            <Plus className="h-4 w-4" />
            Add Transaction
          </Link>
        }
      />
      <ExpenseBrowser
        expenses={expenses}
        isLoading={isLoading}
        mode="my"
        onChanged={() => void qc.invalidateQueries({ queryKey: ['expenses'] })}
      />
    </div>
  );
}
