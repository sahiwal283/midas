import { Link } from 'react-router-dom';
import { Paperclip } from 'lucide-react';

type ReceiptLike = { id: string } | null | undefined;

/**
 * Trade Show–style paperclip pill for expense tables.
 * Links to expense detail (receipts section) so accountants/users can open attachments.
 */
export function ReceiptDetailsButton({
  expenseId,
  receipts,
}: {
  expenseId: string;
  receipts?: ReceiptLike[] | null;
}) {
  const count = receipts?.length ?? 0;
  const label = count === 0
    ? 'No receipt'
    : count === 1
      ? '1 receipt'
      : `${count} receipts`;

  if (count === 0) {
    return (
      <Link
        to={`/expenses/${expenseId}#receipts`}
        className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-400 hover:border-gray-400 hover:text-gray-600"
        title="Open expense to add a receipt"
        onClick={(e) => e.stopPropagation()}
      >
        <Paperclip className="h-3.5 w-3.5 shrink-0 opacity-70" />
        {label}
      </Link>
    );
  }

  return (
    <Link
      to={`/expenses/${expenseId}#receipts`}
      className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-medium text-gray-600 hover:border-gray-300 hover:bg-gray-100 hover:text-gray-800"
      title="View receipt / details"
      onClick={(e) => e.stopPropagation()}
    >
      <Paperclip className="h-3.5 w-3.5 shrink-0 text-gray-500" />
      {label}
    </Link>
  );
}
