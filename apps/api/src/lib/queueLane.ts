import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { expenses } from '../db/schema';

/**
 * SQL equivalent of computeFlags `ready_for_zoho`:
 * approved, not yet in Zoho, complete fields, company posts to Zoho, has a receipt.
 */
export function readyForZohoCondition() {
  return and(
    eq(expenses.status, 'approved'),
    isNull(expenses.zohoExpenseId),
    isNotNull(expenses.zohoEntity),
    isNotNull(expenses.paymentMethodId),
    or(isNotNull(expenses.categoryId), isNotNull(expenses.zohoExpenseAccountId)),
    // See lib/flags.ts, lib/zohoReadiness.ts and apps/web/src/pages/
    // AccountantReview.tsx — the same rule, four ways.
    // The blank-guard here mirrors the TypeScript `.trim()` checks in those
    // files: a blank or whitespace-only reason is not a waiver. `btrim` with no
    // character argument strips ASCII spaces ONLY, so the set is spelled out to
    // match what `.trim()` removes; that leaves only exotic Unicode whitespace
    // (NBSP and friends) between the two, and in that direction the SQL is the
    // permissive one, so the push still refuses. No test reaches this clause:
    // the API suite never touches a database, so it is verified by review and
    // by the post-deploy lane check.
    or(
      sql`exists (select 1 from receipts r where r.expense_id = ${expenses.id})`,
      sql`coalesce(btrim(${expenses.receiptWaiverReason}, E' \\t\\n\\r\\f\\v'), '') <> ''`,
    ),
    // An unmapped card fails the push with MISSING_ZOHO_PAID_THROUGH — not ready.
    // Only a numeric Zoho account id counts; a free-text label is not a mapping.
    sql`exists (
      select 1 from payment_methods pm
      where pm.id = ${expenses.paymentMethodId}
        and pm.zoho_account_name ~ '^[0-9]{10,}$'
    )`,
    sql`exists (
      select 1 from companies c
      where c.name = ${expenses.zohoEntity}
        and c.zoho_enabled = true
        and c.is_active = true
    )`,
  )!;
}

/** Approved expenses with no company — matches the Missing Company lane. */
export function missingEntityCondition() {
  return and(
    eq(expenses.status, 'approved'),
    isNull(expenses.zohoEntity),
  )!;
}
