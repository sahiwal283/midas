import { eq } from 'drizzle-orm';
import { db } from '../../db/index';
import { appConnectionCategories } from '../../db/schema';

/**
 * Category ids a connection may see, or null when unrestricted (no rows).
 * Pure filtering lives in ./categoryVocabulary.
 */
export async function allowedCategoryIds(connectionId: string): Promise<Set<string> | null> {
  const rows = await db
    .select({ categoryId: appConnectionCategories.categoryId })
    .from(appConnectionCategories)
    .where(eq(appConnectionCategories.connectionId, connectionId));
  if (rows.length === 0) return null;
  return new Set(rows.map((r) => r.categoryId));
}
