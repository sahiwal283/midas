/**
 * Which stored expense accounts to rewrite after a category's Zoho account
 * mapping changes for one company.
 *
 * `expenses.zoho_expense_account_id` is a copy of the account the category
 * resolved to when the expense was last categorised, and the payload builder
 * prefers it over the live mapping. Without this, fixing a mapping in Settings
 * leaves every expense already carrying the old id to be rejected by Zoho
 * again on retry.
 *
 * Pure: no db, no env — same reason lib/categoryAccountPick is kept standalone.
 */

export interface StoredAccountRefresh {
  categoryId: string;
  /** Stored ids that are copies of an account this category no longer resolves to. */
  from: string[];
  /** What the category resolves to now; null clears the stored id. */
  to: string | null;
}

export function planStoredAccountRefresh(input: {
  /** The remapped category and its descendants, which inherit its mapping. */
  categoryIds: string[];
  /** categoryId → resolved account before the mapping change. */
  before: Map<string, string | null>;
  /** categoryId → resolved account after it. */
  after: Map<string, string | null>;
  /**
   * categoryId → legacy entity-agnostic expense_categories.zoho_account_id.
   * An expense can hold this id from before the cross-org guard refused it.
   */
  legacyById: Map<string, string | null>;
}): StoredAccountRefresh[] {
  const out: StoredAccountRefresh[] = [];
  for (const categoryId of input.categoryIds) {
    const to = input.after.get(categoryId) ?? null;
    // Only ids known to be copies of this category's own resolution are
    // rewritten. Any other stored id is an account someone picked directly for
    // the expense (the extension's COA picker), and is not ours to replace.
    const from = [...new Set([input.before.get(categoryId), input.legacyById.get(categoryId)])]
      .filter((id): id is string => !!id && id !== to);
    if (from.length > 0) out.push({ categoryId, from, to });
  }
  return out;
}
