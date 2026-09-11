import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { categoryZohoAccounts, expenseCategories } from '../db/schema';
import { ancestryChain } from './categoryTree';
import { pickCategoryAccountId } from './categoryAccountPick';

/**
 * Zoho COA account for (category, company), inheriting up the category tree.
 * Order: per-entity rows for self → ancestors; then legacy zoho_account_id for
 * self → ancestors, skipped when it belongs to a different Zoho org.
 * expenses.zoho_entity stores the company NAME (companies.name).
 */
export async function resolveCategoryEntityAccountId(
  categoryId: string | null,
  zohoEntity: string | null,
): Promise<string | null> {
  if (!categoryId || !zohoEntity) return null;

  const cats = await db.select({
    id: expenseCategories.id,
    parentId: expenseCategories.parentId,
    isActive: expenseCategories.isActive,
    zohoAccountId: expenseCategories.zohoAccountId,
  }).from(expenseCategories);

  const chain = ancestryChain(cats, categoryId);
  if (chain.length === 0) return null;

  const rows = await db.select({
    categoryId: categoryZohoAccounts.categoryId,
    zohoAccountId: categoryZohoAccounts.zohoAccountId,
  }).from(categoryZohoAccounts)
    .where(eq(categoryZohoAccounts.companyName, zohoEntity));
  const perEntity = new Map(rows.map((r) => [r.categoryId, r.zohoAccountId]));

  return pickCategoryAccountId({
    chain,
    perEntity,
    legacyById: new Map(cats.map((c) => [c.id, c.zohoAccountId])),
    companyAccountIds: rows.map((r) => r.zohoAccountId),
  });
}

/**
 * The account columns to write when an expense moves to a different company.
 *
 * `expenses.zoho_expense_account_id` is stored, and the payload builder prefers
 * it over the account resolved at push time — so an id resolved against the old
 * company would survive the move and file the expense under another brand's
 * account. Re-resolve it for the new company, and when nothing resolves, clear
 * it: a push that resolves no account fails visibly, where a stale id misfiles
 * the expense in silence.
 */
export function accountColumnsForCompanyChange(input: {
  categoryId: string | null;
  /** Name of the expense's category, for the stored display name. */
  categoryName: string | null;
  /** What resolveCategoryEntityAccountId returned for the NEW company. */
  resolvedAccountId: string | null;
}): { zohoExpenseAccountId: string | null; zohoExpenseAccountName: string | null } {
  if (!input.categoryId) {
    return { zohoExpenseAccountId: null, zohoExpenseAccountName: null };
  }
  return {
    zohoExpenseAccountId: input.resolvedAccountId,
    zohoExpenseAccountName: input.categoryName,
  };
}
