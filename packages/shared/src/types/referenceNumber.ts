/** Zoho Books Reference Number max length. */
export const REFERENCE_NUMBER_MAX = 50;

export function normalizeReferenceNumber(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, REFERENCE_NUMBER_MAX);
}

/**
 * Prefers an already-extracted OCR field. Otherwise scans receipt text in
 * invoice → receipt → order / sales order → confirmation order.
 */
const TEXT_PATTERNS: RegExp[] = [
  /\binvoice\s*(?:#|no\.?|number)?\s*[:.]?\s*([A-Z0-9][A-Z0-9\-/]{2,})/i,
  /\breceipt\s*(?:#|no\.?|number)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-/]{2,})/i,
  /\b(?:sales\s+)?order\s*(?:#|no\.?|number)?\s*[:.]?\s*([A-Z0-9][A-Z0-9\-/]{2,})/i,
  /\bconfirmation\s*(?:#|no\.?|number)?\s*[:.]?\s*([A-Z0-9][A-Z0-9\-/]{2,})/i,
];

export function pickReferenceNumber(input: {
  field?: string | null;
  text?: string | null;
}): string | null {
  const fromField = normalizeReferenceNumber(input.field);
  if (fromField) return fromField;
  const text = input.text;
  if (!text) return null;
  for (const re of TEXT_PATTERNS) {
    const match = text.match(re);
    const value = normalizeReferenceNumber(match?.[1]);
    if (value) return value;
  }
  return null;
}
