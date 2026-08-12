import { isLikelyDuplicate, DUPLICATE_DATE_TOLERANCE_DAYS } from '../duplicates';

const DAY_MS = 86_400_000;

export interface DuplicateMatch {
  id: string;
  merchant: string;
  amount: number;
  date: string;
}

export interface ExtWarning {
  code: string;
  message: string;
  matches?: DuplicateMatch[];
}

/**
 * Pure duplicate scan over already-fetched candidate rows. Reuses the same
 * matcher the Midas-native create path uses, so a consumer never has to
 * reimplement it or fetch candidates itself.
 */
export function findDuplicateMatches(
  candidate: { merchant: string; amount: number; date: string },
  existing: { id: string; merchant: string; amount: number | string; date: string }[],
): DuplicateMatch[] {
  return existing
    .filter((e) => isLikelyDuplicate(candidate, { merchant: e.merchant, amount: e.amount, date: e.date }))
    .map((e) => ({ id: e.id, merchant: e.merchant, amount: Number(e.amount), date: e.date }));
}

/**
 * Inclusive [from, to] date-string window (YYYY-MM-DD) around `date` within
 * which a row could possibly satisfy isLikelyDuplicate's date check — rows
 * outside it can never match, so a DB query can filter on this window
 * instead of an arbitrary row-count cap and still see every real candidate.
 * Derived from DUPLICATE_DATE_TOLERANCE_DAYS so the window can never drift
 * out of sync with the matcher's own tolerance.
 */
export function duplicateDateWindow(date: string): { from: string; to: string } {
  const base = Date.parse(`${date}T00:00:00Z`);
  const from = new Date(base - DUPLICATE_DATE_TOLERANCE_DAYS * DAY_MS).toISOString().slice(0, 10);
  const to = new Date(base + DUPLICATE_DATE_TOLERANCE_DAYS * DAY_MS).toISOString().slice(0, 10);
  return { from, to };
}
