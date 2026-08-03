import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index';
import { categoryMappings, expenseCategories } from '../../db/schema';

/**
 * Resolve a category for Ext create/import.
 * Order: explicit id → exact name → category_mappings(suggestion) for sourceApp → null.
 */
export async function resolveCategoryId(opts: {
  sourceApp?: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
}): Promise<{ categoryId: string | null; via: 'id' | 'name' | 'mapping' | 'none' }> {
  if (opts.categoryId) {
    const byId = await db.query.expenseCategories.findFirst({
      where: eq(expenseCategories.id, opts.categoryId),
    });
    if (byId) return { categoryId: byId.id, via: 'id' };
  }

  const name = opts.categoryName?.trim();
  if (!name) return { categoryId: null, via: 'none' };

  const byName = await db.query.expenseCategories.findFirst({
    where: eq(expenseCategories.name, name),
  });
  if (byName) return { categoryId: byName.id, via: 'name' };

  if (opts.sourceApp) {
    const mapping = await db.query.categoryMappings.findFirst({
      where: and(
        eq(categoryMappings.sourceApp, opts.sourceApp),
        eq(categoryMappings.suggestion, name),
      ),
    });
    if (mapping) return { categoryId: mapping.categoryId, via: 'mapping' };
  }

  return { categoryId: null, via: 'none' };
}

export async function resolveCategoryIdOrOther(opts: {
  sourceApp?: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
}): Promise<{ categoryId: string | null; warning?: string }> {
  const resolved = await resolveCategoryId(opts);
  if (resolved.categoryId) return { categoryId: resolved.categoryId };

  if (!opts.categoryName) return { categoryId: null };

  const other = await db.query.expenseCategories.findFirst({
    where: eq(expenseCategories.name, 'Other'),
  });
  return {
    categoryId: other?.id ?? null,
    warning: `unknown category "${opts.categoryName}" → Other`,
  };
}
