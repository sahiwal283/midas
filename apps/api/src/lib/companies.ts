import { and, eq } from 'drizzle-orm';
import { db } from '../db/index';
import { companies } from '../db/schema';
import { createError } from '../middleware/error';

/**
 * Ensure zohoEntity / company name is an active row in `companies`.
 * Empty/null is allowed (caller decides whether company is required).
 */
export async function assertActiveCompany(name: string | null | undefined): Promise<string | null> {
  if (name == null || !String(name).trim()) return null;
  const trimmed = String(name).trim();
  const row = await db.query.companies.findFirst({
    where: and(eq(companies.name, trimmed), eq(companies.isActive, true)),
  });
  if (!row) {
    throw createError(
      `Unknown or inactive company "${trimmed}". Pick a company from Settings → Companies.`,
      400,
      'UNKNOWN_COMPANY',
    );
  }
  return row.name;
}

export async function isCompanyZohoEnabled(name: string | null | undefined): Promise<boolean> {
  if (!name?.trim()) return false;
  const row = await db.query.companies.findFirst({ where: eq(companies.name, name.trim()) });
  return !!row?.zohoEnabled && !!row.isActive;
}
