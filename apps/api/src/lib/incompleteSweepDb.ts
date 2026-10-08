import { sql } from 'drizzle-orm';
import { db } from '../db/index';

export interface DueExpense {
  id: string;
  userId: string;
  merchant: string;
  amount: string;
  hasReceipt: boolean;
  receiptWaiverReason: string | null;
  categoryId: string | null;
  zohoExpenseAccountId: string | null;
  paymentMethodId: string | null;
}

/** How long an external app gets to finish uploading before we look. */
const SETTLE_MINUTES = 15;

/**
 * Stamp and return expenses the sweep has not looked at yet: from an
 * events-enabled app, still pending, older than the settle window. The stamp
 * is written in the same statement that selects them, so a crash loses one
 * notification and never sends one twice, and complete expenses are not
 * re-examined on every pass.
 */
export async function claimDueExpenses(sourceApps: string[], limit: number): Promise<DueExpense[]> {
  if (sourceApps.length === 0) return [];
  const apps = sql.join(sourceApps.map((a) => sql`${a}`), sql`, `);
  const result = await db.execute(sql`
    UPDATE expenses e
       SET incomplete_notified_at = now()
     WHERE e.id IN (
       SELECT id FROM expenses
        WHERE status = 'pending'
          AND incomplete_notified_at IS NULL
          AND external_user_id IS NOT NULL
          AND source_app IN (${apps})
          AND created_at < now() - make_interval(mins => ${SETTLE_MINUTES})
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING e.id, e.user_id AS "userId", e.merchant, e.amount::text AS amount,
              e.receipt_waiver_reason AS "receiptWaiverReason",
              e.category_id AS "categoryId",
              e.zoho_expense_account_id AS "zohoExpenseAccountId",
              e.payment_method_id AS "paymentMethodId",
              EXISTS (SELECT 1 FROM receipts r WHERE r.expense_id = e.id) AS "hasReceipt"
  `);
  return result.rows as unknown as DueExpense[];
}
