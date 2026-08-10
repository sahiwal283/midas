/** Canonical provenance values for expenses.source_type / transactions.source_type. */
export const TRANSACTION_SOURCE_TYPES = [
  'manual',
  'online_receipt',
  'purchase_order',
  'browser_extension',
  'trade_show_event',
  'import',
  'partner',
  'other',
] as const;

export type TransactionSourceType = (typeof TRANSACTION_SOURCE_TYPES)[number];

export function normalizeSourceType(raw: string | null | undefined): TransactionSourceType | null {
  if (raw == null || !String(raw).trim()) return null;
  const v = String(raw).trim().toLowerCase().replace(/\s+/g, '_');
  if ((TRANSACTION_SOURCE_TYPES as readonly string[]).includes(v)) {
    return v as TransactionSourceType;
  }
  // Legacy aliases
  if (v === 'extension' || v === 'browser') return 'browser_extension';
  if (v === 'trade_show' || v === 'event') return 'trade_show_event';
  if (v === 'ocr' || v === 'receipt') return 'online_receipt';
  return 'other';
}
