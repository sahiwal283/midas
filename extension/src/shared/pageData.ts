// Page-extracted expense data: shapes, precedence rules, and value parsing.
//
// Pure — no DOM, no chrome APIs — so the rules that decide which candidate
// wins are unit-testable. The DOM scraping that produces candidates lives in
// content/extract.ts.

/** Where a value came from, best first. Drives which candidate wins. */
export type FieldSource =
  /** JSON-LD / microdata / OG — machine-authored by the site. Trust most. */
  | 'structured'
  /** Text adjacent to an explicit label ("Order Total: $42.50"). */
  | 'labeled'
  /** A site-specific selector we hand-picked (e.g. Amazon order details). */
  | 'site'
  /** Whole-page heuristics. Weakest — often wrong on busy pages. */
  | 'heuristic';

export const SOURCE_RANK: Record<FieldSource, number> = {
  structured: 0,
  labeled: 1,
  site: 2,
  heuristic: 3,
};

export interface FieldCandidate<T> {
  value: T;
  source: FieldSource;
  /** Optional tiebreak within a source (e.g. how close the label was). */
  weight?: number;
}

export interface ResolvedField<T> {
  value: T;
  source: FieldSource;
}

export interface PageData {
  merchant: ResolvedField<string> | null;
  amount: ResolvedField<number> | null;
  /** YYYY-MM-DD */
  date: ResolvedField<string> | null;
  reference: ResolvedField<string> | null;
  items: string[];
  pageUrl: string;
}

/**
 * Best candidate by source rank, then by weight, then first-seen.
 *
 * Deliberately NOT "largest value wins" — the extension this replaces took
 * Math.max of every price on the page, so a struck-through "was $199.99" or an
 * unrelated pricier item beat the actual order total.
 */
export function resolveField<T>(candidates: FieldCandidate<T>[]): ResolvedField<T> | null {
  let best: FieldCandidate<T> | null = null;
  for (const c of candidates) {
    if (c.value == null || c.value === '') continue;
    if (best === null) {
      best = c;
      continue;
    }
    const rank = SOURCE_RANK[c.source] - SOURCE_RANK[best.source];
    if (rank < 0 || (rank === 0 && (c.weight ?? 0) > (best.weight ?? 0))) best = c;
  }
  return best ? { value: best.value, source: best.source } : null;
}

/** "$1,234.56" / "1234.56" / "USD 42.50" → 1234.56. Null when not money. */
export function parseMoney(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;
  // Strip currency symbols/codes, keeping digits and separators.
  const cleaned = raw.replace(/[^\d.,]/g, '').trim();
  if (!cleaned) return null;
  // Must LOOK like money. Without this, "Order #114-3941689" parses as 114 —
  // an order number silently becomes the expense amount.
  if (!/^\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?$|^\d+(?:[.,]\d{1,2})?$/.test(cleaned)) return null;
  // "1.234,56" (European) vs "1,234.56" — whichever separator is last is decimal.
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized = cleaned;
  if (lastComma > lastDot) normalized = cleaned.replace(/\./g, '').replace(',', '.');
  else normalized = cleaned.replace(/,/g, '');
  const n = Number.parseFloat(normalized);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Guard against absurd values from a mis-scrape (e.g. an order number).
  return n > 1_000_000 ? null : Math.round(n * 100) / 100;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a date to YYYY-MM-DD in LOCAL terms. Note `new Date('2026-03-30')`
 * parses as UTC midnight, which renders as the 29th west of Greenwich — so
 * ISO input is passed through as text rather than round-tripped through Date.
 */
export function parseDateToIso(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (ISO_DATE.test(trimmed)) return trimmed;
  // Datetime strings: take the date part before any 'T'.
  const isoPrefix = trimmed.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (isoPrefix) return isoPrefix[1];

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  const year = parsed.getFullYear();
  if (year < 2000 || year > 2100) return null;
  const m = String(parsed.getMonth() + 1).padStart(2, '0');
  const d = String(parsed.getDate()).padStart(2, '0');
  return `${year}-${m}-${d}`;
}

/** Fallback merchant from the hostname: "www.bestbuy.com" → "Bestbuy". */
export function merchantFromUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const base = host.split('.')[0];
    if (!base || base.length < 2) return null;
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch {
    return null;
  }
}

/** Compact "Items: a, b, +3 more" summary for the description field. */
export function describeItems(items: string[], max = 2): string {
  const clean = items.map((i) => i.trim()).filter(Boolean);
  if (clean.length === 0) return '';
  const shown = clean.slice(0, max).join(', ');
  const rest = clean.length - max;
  return rest > 0 ? `Items: ${shown}, +${rest} more` : `Items: ${shown}`;
}
