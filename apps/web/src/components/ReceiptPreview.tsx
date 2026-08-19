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
    <a href={url} target="_blank" rel="noreferrer" className="block">
      <img
        src={url}
        alt={receipt.filename}
        className={`mx-auto max-h-[28rem] w-auto max-w-full rounded-lg border border-ink/10 object-contain ${className}`}
      />
    </a>
  );
}
