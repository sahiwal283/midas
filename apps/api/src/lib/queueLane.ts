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
    sql`exists (select 1 from receipts r where r.expense_id = ${expenses.id})`,
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
