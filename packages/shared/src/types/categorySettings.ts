/** Settings helpers for the category tree and Chart of Accounts mapping. */

export interface CategoryDeleteRefs {
  expenses: number;
  transactions: number;
  children: number;
  budgets: number;
}

function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Human reason the category cannot be hard-deleted, or null if unused. */
export function categoryDeleteBlocker(refs: CategoryDeleteRefs): string | null {
  const parts: string[] = [];
  if (refs.children > 0) {
    parts.push(
      `This has ${counted(refs.children, 'child category', 'child categories')}. Move them to another parent first.`,
    );
  }
  if (refs.expenses > 0) {
    parts.push(
      `${counted(refs.expenses, 'expense', 'expenses')} still use this. Hide it from pickers, or recategorize them first.`,
    );
  }
  if (refs.transactions > 0) {
    parts.push(
      `${counted(refs.transactions, 'transaction', 'transactions')} still use this. Hide it, or recategorize those lines first.`,
    );
  }
  if (refs.budgets > 0) {
    parts.push(
      `${counted(refs.budgets, 'budget', 'budgets')} still use this. Remove or recategorize those budgets first.`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

export interface NamedCategory {
  id: string;
  name: string;
  parentId: string | null;
  description?: string | null;
}

function haystack(cat: NamedCategory): string {
  return `${cat.name} ${cat.description ?? ''}`.toLowerCase();
}

/**
 * Category ids that match `query`, plus every ancestor so the tree still
 * has a parent to hang a nested hit under. Empty query → every id.
 */
export function matchingCategoryIdSet(cats: NamedCategory[], query: string): Set<string> {
  const q = query.trim().toLowerCase();
  if (!q) return new Set(cats.map((c) => c.id));

  const byId = new Map(cats.map((c) => [c.id, c]));
  const hits = new Set<string>();
  for (const cat of cats) {
    if (!haystack(cat).includes(q)) continue;
    let cur: NamedCategory | undefined = cat;
    while (cur && !hits.has(cur.id)) {
      hits.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  return hits;
}

export interface CoaAccount {
  accountId: string;
  accountName: string;
  accountCode: string | null;
}

export interface CoaMapping {
  categoryId: string;
  zohoAccountId: string;
}

export interface CoaAccountRow extends CoaAccount {
  categoryIds: string[];
}

/** Zoho accounts in list order, each carrying the Midas categories mapped to it. */
export function groupCoaByAccount(accounts: CoaAccount[], mappings: CoaMapping[]): CoaAccountRow[] {
  const byAccount = new Map<string, string[]>();
  for (const m of mappings) {
    byAccount.set(m.zohoAccountId, [...(byAccount.get(m.zohoAccountId) ?? []), m.categoryId]);
  }
  const rows: CoaAccountRow[] = accounts.map((a) => ({
    ...a,
    categoryIds: byAccount.get(a.accountId) ?? [],
  }));
  for (const [accountId, categoryIds] of byAccount) {
    if (rows.some((r) => r.accountId === accountId)) continue;
    rows.push({
      accountId,
      accountName: accountId,
      accountCode: null,
      categoryIds,
    });
  }
  return rows;
}

export interface FilterableCoaAccount {
  accountId: string;
  accountName: string;
  accountCode: string | null;
  categoryNames: string[];
}

/** Keep accounts whose name, code, or an attached Midas category matches. */
export function filterCoaAccounts<T extends FilterableCoaAccount>(rows: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) => {
    if (row.accountName.toLowerCase().includes(q)) return true;
    if (row.accountCode?.toLowerCase().includes(q)) return true;
    return row.categoryNames.some((name) => name.toLowerCase().includes(q));
  });
}
