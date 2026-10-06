import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/index';
import { categoryZohoAccounts, expenseCategories, expenses } from '../db/schema';
import { ancestryChain, descendantIds } from './categoryTree';
import { pickCategoryAccountId } from './categoryAccountPick';
import { planStoredAccountRefresh } from './storedAccountRefresh';
import { syncExpenseToTransaction } from './syncExpenseTransaction';
import { auditLog } from './audit';

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

/** What a category and its descendants resolve to for one company, right now. */
async function resolveSubtreeAccounts(categoryId: string, companyName: string) {
  const cats = await db.select({
    id: expenseCategories.id,
    parentId: expenseCategories.parentId,
    isActive: expenseCategories.isActive,
    zohoAccountId: expenseCategories.zohoAccountId,
  }).from(expenseCategories);
  const categoryIds = descendantIds(cats, categoryId);
  const accounts = new Map<string, string | null>();
  for (const id of categoryIds) {
    accounts.set(id, await resolveCategoryEntityAccountId(id, companyName));
  }
  return { categoryIds, accounts, legacyById: new Map(cats.map((c) => [c.id, c.zohoAccountId])) };
}

/**
 * Runs a change to one (category, company) mapping, then carries it to the
 * unpushed expenses still holding a copy of the account the category resolved
 * to before. Pushed expenses are left alone: their account is whatever Zoho
 * Books recorded. Returns the write's result and how many expenses moved.
 */
export async function withStoredAccountRefresh<T>(
  input: { categoryId: string; companyName: string; actorUserId: string },
  write: () => Promise<T>,
): Promise<{ result: T; refreshed: number }> {
  const before = await resolveSubtreeAccounts(input.categoryId, input.companyName);
  const result = await write();
  const after = await resolveSubtreeAccounts(input.categoryId, input.companyName);

  let refreshed = 0;
  for (const plan of planStoredAccountRefresh({
    categoryIds: after.categoryIds,
    before: before.accounts,
    after: after.accounts,
    legacyById: after.legacyById,
  })) {
    const stale = await db.select({ id: expenses.id, zohoExpenseAccountId: expenses.zohoExpenseAccountId })
      .from(expenses)
      .where(and(
        eq(expenses.categoryId, plan.categoryId),
        eq(expenses.zohoEntity, input.companyName),
        isNull(expenses.zohoExpenseId),
        inArray(expenses.zohoExpenseAccountId, plan.from),
      ));
    for (const row of stale) {
      const [updated] = await db.update(expenses)
        .set({ zohoExpenseAccountId: plan.to, updatedAt: new Date() })
        .where(eq(expenses.id, row.id))
        .returning();
      await syncExpenseToTransaction(updated);
      await auditLog({
        entityType: 'expense',
        entityId: row.id,
        userId: input.actorUserId,
        action: 'zoho.account_remapped',
        before: { zohoExpenseAccountId: row.zohoExpenseAccountId },
        after: { zohoExpenseAccountId: plan.to },
        metadata: { reason: 'category mapping changed', companyName: input.companyName },
      });
      refreshed += 1;
    }
  }
  return { result, refreshed };
}
