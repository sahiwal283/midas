import type { Receipt } from '../types';

/** Authenticated file URL (cookie sent on same-origin img/iframe). */
export function receiptContentUrl(_expenseId: string, receiptId: string): string {
  return `/api/v1/files/receipts/${receiptId}`;
}

export function ReceiptPreview({
  expenseId,
  receipt,
  className = '',
}: {
  expenseId: string;
  receipt: Pick<Receipt, 'id' | 'filename' | 'mimeType'>;
  className?: string;
}) {
  const url = receiptContentUrl(expenseId, receipt.id);
  const isPdf = receipt.mimeType === 'application/pdf'
    || receipt.filename.toLowerCase().endsWith('.pdf');

  if (isPdf) {
    return (
      <iframe
        title={receipt.filename}
        src={url}
        className={`w-full rounded-lg border border-ink/10 bg-white ${className || 'h-96'}`}
      />
    );
  }

  return (
    // `className` replaces the height cap rather than stacking with it — two
    // max-h utilities on one element resolve by stylesheet order, not by the
    // order they're written here, so the caller's cap would not reliably win.
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <img
        src={url}
        alt={`Receipt: ${receipt.filename}`}
        loading="lazy"
        className={`mx-auto w-auto max-w-full rounded-lg border border-ink/10 bg-white object-contain ${className || 'max-h-[28rem]'}`}
      />
    </a>
  );
}
