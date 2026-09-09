import { matchZohoItem, type MatchableZohoItem } from '@midas/shared';

/** A PO form line, mirroring the draft shape PurchaseOrderNew edits. */
export interface LineDraft {
  lineNumber: number;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  tax: string;
  total: string;
  zohoItemId: string;
  /** OCR's confidence in this line, null when the line was typed by hand. */
  ocrConfidence: number | null;
  /** Catalogue match score, null when nothing matched or the line was typed. */
  matchScore: number | null;
}

type OcrFieldish = { value?: unknown } | undefined;

function fieldString(field: OcrFieldish): string {
  return typeof field?.value === 'string' && field.value.trim() ? field.value.trim() : '';
}

function numberString(value: unknown, fallback: string): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : fallback;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The unit price implied by a line that quotes only a total — the common shape
 * for a lump-sum PO line ('Drayage handling ... 275.00'). Rounded to the four
 * decimals the `unit_price` column stores, which keeps the field readable and
 * keeps the recomputed total agreeing with it to the cent.
 *
 * Returns null when there is nothing to derive from, or when the quantity is
 * zero or negative and the division would be meaningless — the caller then
 * falls back to 0, as before.
 */
function unitPriceFromTotal(total: number | null, tax: number, quantity: number): string | null {
  if (total === null) return null;
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  return String(Math.round(((total - tax) / quantity) * 10_000) / 10_000);
}

/**
 * Header values OCR could read off a purchase order.
 * Anything unreadable comes back as '' so the form shows an empty field the user
 * can fill, rather than a wrong value they might not notice.
 */
export function poHeaderFromOcr(ocrData: unknown): {
  vendorName: string;
  transactionDate: string;
  taxTotal: string;
} {
  const fields = (ocrData as { fields?: Record<string, OcrFieldish> } | null)?.fields;
  const rawDate = fieldString(fields?.date);
  return {
    vendorName: fieldString(fields?.merchant),
    // The date input needs an ISO day; anything else is dropped rather than
    // guessed at.
    transactionDate: /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : '',
    taxTotal: fieldString(fields?.taxAmount),
  };
}

/**
 * Turn OCR line items into editable form drafts, preselecting a Zoho catalogue
 * item where the match is confident enough.
 *
 * Line totals are recomputed from quantity, price and tax rather than taken from
 * OCR: the arithmetic has to agree with what the form shows the user, and a
 * misread total that silently disagrees with its own line is worse than one the
 * user can see and correct.
 *
 * That argument only bites when there is a unit price for the total to disagree
 * with. A line quoted as a lump sum — a total and nothing else, which is how
 * most PO lines read — has no such conflict, so its unit price is derived from
 * the total instead of defaulting to zero. Defaulting there would recompute the
 * total as 0.00 and throw away the one number OCR actually read.
 */
export function lineDraftsFromOcr(
  ocrData: unknown,
  items: MatchableZohoItem[],
): LineDraft[] {
  const raw = (ocrData as { lineItems?: unknown } | null)?.lineItems;
  if (!Array.isArray(raw)) return [];

  return raw.map((entry, index) => {
    // entry can be anything an untrusted OCR payload contains, including null
    // or undefined array holes — guard before destructuring rather than
    // casting, so a malformed line degrades to an empty draft instead of
    // throwing. Mirrors the same guard in ocr-client's serviceAdapter.
    const li = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const description = typeof li.description === 'string' ? li.description : '';
    const quantity = numberString(li.quantity, '1');
    const tax = numberString(li.tax, '0');
    const unitPrice = finiteNumber(li.unitPrice) !== null
      ? numberString(li.unitPrice, '0')
      : unitPriceFromTotal(finiteNumber(li.total), Number(tax) || 0, Number(quantity)) ?? '0';
    const match = description ? matchZohoItem(description, items) : null;

    return {
      lineNumber: index + 1,
      description,
      quantity,
      unit: typeof li.unit === 'string' ? li.unit : '',
      unitPrice,
      tax,
      total: ((Number(quantity) || 0) * (Number(unitPrice) || 0) + (Number(tax) || 0)).toFixed(2),
      zohoItemId: match?.itemId ?? '',
      ocrConfidence: typeof li.confidence === 'number' ? li.confidence : null,
      matchScore: match?.score ?? null,
    };
  });
}
