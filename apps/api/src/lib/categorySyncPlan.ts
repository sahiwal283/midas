/**
 * Pure planning for the Zoho COA → Midas category import (no db/env imports;
 * the db/network orchestration lives in routes/admin.ts). For one company:
 * accounts with no same-named category become new top-level categories;
 * name-matched categories get a (category, company) → account mapping unless
 * the company already has one — an accountant's deliberate mapping wins.
 */

export interface SyncAccount {
  accountId: string;
  accountName: string;
}

export interface CategorySyncPlan {
  /** Categories to create, each carrying the account to map afterwards. */
  create: { name: string; accountId: string }[];
  /** Mappings to add for existing categories. */
  map: { categoryId: string; accountId: string }[];
}

export function planCategorySync(
  existing: { id: string; name: string }[],
  accounts: SyncAccount[],
  mappedAccountByCategory: Map<string, string>,
): CategorySyncPlan {
  const byName = new Map(existing.map((c) => [c.name.trim().toLowerCase(), c]));
  const plan: CategorySyncPlan = { create: [], map: [] };

  for (const account of accounts) {
    const name = account.accountName.trim();
    if (!name) continue;
    const match = byName.get(name.toLowerCase());
    if (!match) {
      plan.create.push({ name, accountId: account.accountId });
      continue;
    }
    if (!mappedAccountByCategory.has(match.id)) {
      plan.map.push({ categoryId: match.id, accountId: account.accountId });
    }
  }

  return plan;
}
