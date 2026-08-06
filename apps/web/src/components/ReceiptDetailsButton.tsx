import { Paperclip } from 'lucide-react';

type ReceiptLike = { id: string } | null | undefined;

/**
 * Trade Show–style paperclip pill for expense tables.
 * Opens a quick-view modal (inline receipt) via onOpen — does not navigate away.
 */
export function ReceiptDetailsButton({
  expenseId,
  receipts,
  onOpen,
}: {
  expenseId: string;
  receipts?: ReceiptLike[] | null;
  onOpen: (expenseId: string) => void;
}) {
  const count = receipts?.length ?? 0;
  const label = count === 0
    ? 'No receipt'
    : count === 1
      ? '1 receipt'
      : `${count} receipts`;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(expenseId);
      }}
      className={
        count === 0
          ? 'inline-flex items-center gap-1.5 rounded-full border border-dashed border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-400 hover:border-gray-400 hover:text-gray-600'
          : 'inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-medium text-gray-600 hover:border-gray-300 hover:bg-gray-100 hover:text-gray-800'
      }
      title={count === 0 ? 'Open expense details' : 'View receipt / details'}
    >
      <Paperclip className={`h-3.5 w-3.5 shrink-0 ${count === 0 ? 'opacity-70' : 'text-gray-500'}`} />
      {label}
    </button>
  );
}
