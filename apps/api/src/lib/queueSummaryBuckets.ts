import { isDailyExpense } from './queueScope';

/**
 * Partition queue rows into the two review pages. Pure and total: every row
 * lands in exactly one bucket, so the dashboard's per-scope numbers always sum
 * to its combined totals.
 */
export function splitRowsByScope<T extends { sourceApp: string | null }>(
  rows: T[],
): { event: T[]; daily: T[] } {
  const event: T[] = [];
  const daily: T[] = [];
  for (const row of rows) {
    if (isDailyExpense(row)) daily.push(row);
    else event.push(row);
  }
  return { event, daily };
}
