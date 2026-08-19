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
          ? 'inline-flex items-center gap-1.5 rounded-full border border-dashed border-ink/15 bg-white px-2.5 py-1 text-xs font-medium text-charcoal/40 hover:border-ink/25 hover:text-charcoal/70'
          : 'inline-flex items-center gap-1.5 rounded-full border border-ink/10 bg-cream px-2.5 py-1 text-xs font-medium text-charcoal/70 hover:border-ink/20 hover:bg-brand-50 hover:text-ink'
      }
      title={count === 0 ? 'Open expense details' : 'View receipt / details'}
    >
      <Paperclip className={`h-3.5 w-3.5 shrink-0 ${count === 0 ? 'opacity-70' : 'text-muted'}`} />
      {label}
    </button>
  );
}
