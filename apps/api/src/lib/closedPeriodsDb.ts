import { db } from '../db/index';
import { closedPeriods } from '../db/schema';

/**
 * All closed periods ('YYYY-MM'). Query once per request and pass the array
 * into the pure helpers in lib/closedPeriods.ts.
 */
export async function getClosedPeriods(): Promise<string[]> {
  const rows = await db.select({ period: closedPeriods.period }).from(closedPeriods);
  return rows.map((r) => r.period);
}
