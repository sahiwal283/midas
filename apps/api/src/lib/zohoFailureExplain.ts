/**
 * Turns a Zoho account rejection into something an accountant can act on.
 *
 * Zoho's own wording ("Please enter valid expense account") reads as "pick a
 * category" — but the category is always set by the time a push is attempted.
 * What Zoho rejected is the account id behind it, and the fix lives in
 * Settings, not on the expense. This says which, for whom, and where.
 *
 * Pure: no db, no env — same reason lib/zohoErrors is kept standalone.
 */
import type { ZohoErrorCategory } from './zohoErrors';

/**
 * Where the expense account id in the payload came from, in the order
 * buildZohoServicePayload resolves it.
 * - `stale_pin`: the id stored on the expense differs from the company's
 *   current mapping for its category — the mapping moved on, the expense didn't.
 * - `legacy`: the category's company-agnostic default, not a mapping made for
 *   this company.
 */
export type ExpenseAccountSource = 'pinned' | 'stale_pin' | 'company_map' | 'legacy';

export function expenseAccountSource(ids: {
  /** expenses.zoho_expense_account_id */
  pinned: string | null | undefined;
  /** resolveCategoryEntityAccountId for (category, company) — may itself be the legacy id. */
  resolved: string | null | undefined;
  /** expense_categories.zoho_account_id */
  legacy: string | null | undefined;
}): ExpenseAccountSource {
  const pinned = ids.pinned?.trim();
  const resolved = ids.resolved?.trim();
  const legacy = ids.legacy?.trim();
  if (pinned && resolved && pinned !== resolved) return 'stale_pin';
  if (pinned && !resolved) return 'pinned';
  return resolved && resolved !== legacy ? 'company_map' : 'legacy';
}

export interface ZohoFailureContext {
  /** expenses.zoho_entity — the company NAME. */
  company: string | null;
  categoryName: string | null;
  paymentMethodLabel: string | null;
  accountSource: ExpenseAccountSource;
}

export function explainZohoFailure(
  category: ZohoErrorCategory,
  zohoMessage: string,
  ctx: ZohoFailureContext,
): string {
  if (category !== 'MAPPING_ERROR') return zohoMessage;

  const msg = zohoMessage.toLowerCase();
  const company = ctx.company ?? 'this company';
  const said = ` (Zoho said: "${zohoMessage}")`;

  if (msg.includes('paid through') || msg.includes('paid_through')) {
    const pm = ctx.paymentMethodLabel ? `payment method "${ctx.paymentMethodLabel}"` : 'payment method';
    return `Zoho rejected the paid-through account behind the ${pm} — it is not a valid account in ${company}'s Zoho Books. `
      + `To fix: Settings → Payment Methods → re-pick the Zoho account for this payment method, then Retry.${said}`;
  }

  if (msg.includes('expense account')) {
    const cat = ctx.categoryName ? `category "${ctx.categoryName}"` : 'category';
    const lead = `The ${cat} is set, but Zoho rejected the Zoho account it posts to. `;
    const settings = `Settings → Chart of Accounts → ${company}`;
    switch (ctx.accountSource) {
      case 'legacy':
        return `${lead}This category is not attached to a ${company} account, so its default account was sent. `
          + `To fix: ${settings} → attach this category to an account, then Retry.${said}`;
      case 'stale_pin':
        return `${lead}This expense still carries an older account than the one ${company} maps this category to now. `
          + `To fix: change the category on this expense to another one and back so it picks up the current account, then Retry.${said}`;
      default:
        return `${lead}That account is not valid in ${company}'s Zoho Books — it may have been deleted or deactivated there. `
          + `To fix: ${settings} → attach this category to a current account, then Retry.${said}`;
    }
  }

  return zohoMessage;
}
