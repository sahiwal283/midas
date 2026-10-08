import { sql } from 'drizzle-orm';
import { db } from '../db/index';

export interface DueExpense {
  id: string;
  userId: string;
  sourceApp: string;
  merchant: string;
  amount: string;
  hasReceipt: boolean;
  receiptWaiverReason: string | null;
  categoryId: string | null;
  zohoExpenseAccountId: string | null;
  paymentMethodId: string | null;
  /** The card as the app sent it (source_context.cardUsed), mapped or not. */
  cardUsed: string | null;
}

/** How long an external app gets to finish uploading before we look. */
const SETTLE_MINUTES = 15;

/**
 * Stamp and return expenses the sweep has not looked at yet: from any external
 * app (whatever its events setting — the caller decides who is told), still
 * pending, older than the settle window. Claiming regardless of the setting
 * means no backlog of unstamped expenses can build up before an app switches
 * events on. The stamp is written in the same statement that selects them, so
 * a crash loses one notification and never sends one twice, and complete
 * expenses are not re-examined on every pass.
 */
export async function claimDueExpenses(limit: number): Promise<DueExpense[]> {
  const result = await db.execute(sql`
    UPDATE expenses e
       SET incomplete_notified_at = now()
     WHERE e.id IN (
       SELECT id FROM expenses
        WHERE status = 'pending'
          AND incomplete_notified_at IS NULL
          AND external_user_id IS NOT NULL
          AND source_app IS NOT NULL
          AND created_at < now() - make_interval(mins => ${SETTLE_MINUTES})
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING e.id, e.user_id AS "userId", e.source_app AS "sourceApp",
              e.merchant, e.amount::text AS amount,
              e.receipt_waiver_reason AS "receiptWaiverReason",
              e.category_id AS "categoryId",
              e.zoho_expense_account_id AS "zohoExpenseAccountId",
              e.payment_method_id AS "paymentMethodId",
              e.source_context->>'cardUsed' AS "cardUsed",
              EXISTS (SELECT 1 FROM receipts r WHERE r.expense_id = e.id) AS "hasReceipt"
  `);
  return result.rows as unknown as DueExpense[];
}
