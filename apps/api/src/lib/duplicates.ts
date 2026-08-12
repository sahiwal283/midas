/** Likely-duplicate matcher: same amount, close date, similar merchant. */

const DAY_MS = 86_400_000;

/**
 * Max days apart two dates may be and still be considered a possible
 * duplicate. Exported so callers that need to pre-filter candidates by date
 * (e.g. a DB query) can derive their window from this instead of hardcoding
 * a second copy of the tolerance that could drift out of sync.
 */
export const DUPLICATE_DATE_TOLERANCE_DAYS = 3;

function normalizeMerchant(m: string): string {
  return m.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

export function isLikelyDuplicate(
  candidate: { merchant: string; amount: number; date: string },
  existing: { merchant: string; amount: number | string; date: string },
): boolean {
  if (Math.abs(Number(existing.amount) - candidate.amount) > 0.005) return false;

  const dayDiff = Math.abs(Date.parse(`${candidate.date}T00:00:00Z`) - Date.parse(`${existing.date}T00:00:00Z`)) / DAY_MS;
  if (!Number.isFinite(dayDiff) || dayDiff > DUPLICATE_DATE_TOLERANCE_DAYS) return false;

  const a = normalizeMerchant(candidate.merchant);
  const b = normalizeMerchant(existing.merchant);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}
