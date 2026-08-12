import { db } from '../db/index';

/** Pure: company name → whether it can post to Zoho at all. */
export function buildZohoEnabledMap(
  rows: { name: string; zohoEnabled: boolean; isActive: boolean }[],
): Map<string, boolean> {
  return new Map(rows.map((c) => [c.name, c.zohoEnabled && c.isActive]));
}

/**
 * One query for the whole company list. There are a handful of companies, so the
 * accountant queue reads them once per request rather than joining per row.
 */
export async function zohoEnabledByCompanyName(): Promise<Map<string, boolean>> {
  const rows = await db.query.companies.findMany({
    columns: { name: true, zohoEnabled: true, isActive: true },
  });
  return buildZohoEnabledMap(rows);
}
