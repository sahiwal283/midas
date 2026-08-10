import { Link } from 'react-router-dom';

/** Chooser: Expense vs Purchase Order before opening the capture wizard. */
export function TransactionNew() {
  return (
    <div className="mx-auto max-w-lg px-4 py-10">
      <h1 className="font-display text-2xl text-ink mb-2">Add Transaction</h1>
      <p className="text-sm text-charcoal/70 mb-8">
        What are you uploading?
      </p>
      <div className="grid gap-4">
        <Link
          to="/expenses/new"
          className="block rounded-xl border border-brand-200 bg-white px-5 py-6 shadow-sm hover:border-brand-500 hover:bg-brand-50/40 transition"
        >
          <div className="text-lg font-semibold text-ink">Expense</div>
          <p className="mt-1 text-sm text-charcoal/70">
            Employee spend — meals, travel, supplies. One total amount.
          </p>
        </Link>
        <Link
          to="/transactions/po/new"
          className="block rounded-xl border border-brand-200 bg-white px-5 py-6 shadow-sm hover:border-brand-500 hover:bg-brand-50/40 transition"
        >
          <div className="text-lg font-semibold text-ink">Purchase Order</div>
          <p className="mt-1 text-sm text-charcoal/70">
            Vendor order with line items — quantity, unit, and unit price.
          </p>
        </Link>
      </div>
    </div>
  );
}
