import { and, eq } from 'drizzle-orm';
import { db } from '../db/index';
import { companies, expenseCategories, categoryZohoAccounts } from '../db/schema';
import { planCategorySync } from './categorySyncPlan';
import { listExpenseAccounts, ZohoServiceError } from './zoho';
import { resolveBrandFromEntity } from './zohoBrand';
import { auditLog } from './audit';

export interface CompanySyncSummary {
  company: string;
  brand: string | null;
  accounts: number;
  created: string[];
  mapped: number;
  error?: string;
}

/**
 * Import expense-class accounts from each Zoho-enabled company's live chart
 * of accounts: unknown account names become new top-level categories; matched
 * names gain a (category, company) mapping unless one already exists (a
 * deliberate accountant mapping is never overwritten). Idempotent.
 */
export async function syncCategoriesFromZoho(actorUserId: string | null): Promise<CompanySyncSummary[]> {
  const activeCompanies = await db.query.companies.findMany({
    where: and(eq(companies.isActive, true), eq(companies.zohoEnabled, true)),
  });

  const summary: CompanySyncSummary[] = [];

  for (const company of activeCompanies) {
    const brand = resolveBrandFromEntity(company.name);
    if (!brand) {
      summary.push({ company: company.name, brand: null, accounts: 0, created: [], mapped: 0, error: 'no Zoho brand mapping' });
      continue;
    }

    let accounts;
    try {
      accounts = await listExpenseAccounts(brand);
    } catch (err) {
      summary.push({
        company: company.name,
        brand,
        accounts: 0,
        created: [],
        mapped: 0,
        error: err instanceof ZohoServiceError ? `${err.code}: ${err.message}` : (err as Error).message,
      });
      continue;
    }

    // Re-read per company: a category created for one company must be seen
    // (and only mapped, not duplicated) by the next.
    const existing = await db.query.expenseCategories.findMany({
      columns: { id: true, name: true },
    });
    const mappings = await db.select({
      categoryId: categoryZohoAccounts.categoryId,
      zohoAccountId: categoryZohoAccounts.zohoAccountId,
    }).from(categoryZohoAccounts).where(eq(categoryZohoAccounts.companyName, company.name));
    const mappedByCategory = new Map(mappings.map((m) => [m.categoryId, m.zohoAccountId]));

    const plan = planCategorySync(existing, accounts, mappedByCategory);

    const created: string[] = [];
    let mapped = 0;
    for (const c of plan.create) {
      const [cat] = await db.insert(expenseCategories).values({
        name: c.name,
        description: `Imported from Zoho chart of accounts (${brand})`,
      }).onConflictDoNothing({ target: expenseCategories.name }).returning();
      const catId = cat?.id
        ?? (await db.query.expenseCategories.findFirst({ where: eq(expenseCategories.name, c.name) }))?.id;
      if (!catId) continue;
      if (cat) created.push(c.name);
      await db.insert(categoryZohoAccounts)
        .values({ categoryId: catId, companyName: company.name, zohoAccountId: c.accountId })
        .onConflictDoNothing();
      mapped++;
    }
    for (const m of plan.map) {
      await db.insert(categoryZohoAccounts)
        .values({ categoryId: m.categoryId, companyName: company.name, zohoAccountId: m.accountId })
        .onConflictDoNothing();
      mapped++;
    }

    summary.push({ company: company.name, brand, accounts: accounts.length, created, mapped });
  }

  await auditLog({
    entityType: 'expense_category',
    entityId: 'sync-zoho',
    userId: actorUserId ?? undefined,
    action: 'categories_synced_from_zoho',
    metadata: { summary },
  });

  return summary;
}
