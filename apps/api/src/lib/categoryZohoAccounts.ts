import { and, eq } from 'drizzle-orm';
import { db } from '../db/index';
import { categoryZohoAccounts } from '../db/schema';

/**
 * Zoho COA account for (category, company). expenses.zoho_entity stores the
 * company NAME (companies.name), which is what company_name references.
 */
export async function resolveCategoryEntityAccountId(
  categoryId: string | null,
  zohoEntity: string | null,
): Promise<string | null> {
  if (!categoryId || !zohoEntity) return null;
  const [row] = await db
    .select({ zohoAccountId: categoryZohoAccounts.zohoAccountId })
    .from(categoryZohoAccounts)
    .where(and(
      eq(categoryZohoAccounts.categoryId, categoryId),
      eq(categoryZohoAccounts.companyName, zohoEntity),
    ))
    .limit(1);
  return row?.zohoAccountId ?? null;
}
