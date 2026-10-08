/**
 * "Expense missing details" for external-app expenses. An app creates the
 * expense first and uploads its receipt a moment later, so checking at
 * creation would always report a missing receipt. This looks once, 15
 * minutes later, and tells the submitter (through the hand-off) what to add.
 */
import { logger } from './logger';
import { notifyUser } from './notify';
import { eventEnabledSourceApps } from './extEventsDb';
import { claimDueExpenses } from './incompleteSweepDb';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const STARTUP_DELAY_MS = 30 * 1000;
const BATCH = 100;

/**
 * The same three checks lib/flags uses for missing_receipt, needs_category and
 * needs_payment_method, with one difference: a card the app sent as free text
 * (`source_context.cardUsed`) counts as a payment method. Midas maps that text
 * to a payment method only when it matches one, and mapping the rest is the
 * accountant's job; the submitter has already supplied it.
 */
export function missingDetails(e: {
  hasReceipt: boolean;
  receiptWaiverReason?: string | null;
  categoryId: string | null;
  zohoExpenseAccountId: string | null;
  paymentMethodId: string | null;
  cardUsed?: string | null;
}): string[] {
  const missing: string[] = [];
  if (!e.hasReceipt && !(e.receiptWaiverReason ?? '').trim()) missing.push('receipt');
  if (!e.categoryId && !e.zohoExpenseAccountId) missing.push('category');
  if (!e.paymentMethodId && !(e.cardUsed ?? '').trim()) missing.push('payment method');
  return missing;
}

let running = false;

/** One pass. Never throws. */
export async function runIncompleteSweep(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Looked up before claiming: if this fails, nothing has been stamped yet.
    const enabled = new Set(await eventEnabledSourceApps());

    // Always claim, whatever any app's events setting, so every expense is
    // stamped once it settles and switching events on later finds no backlog.
    const due = await claimDueExpenses(BATCH);
    for (const expense of due) {
      if (!enabled.has(expense.sourceApp)) continue;
      const missing = missingDetails(expense);
      if (missing.length === 0) continue;
      // notifyUser hands this to the source app and never throws. No email: if
      // the hand-off declines mid-pass, Midas's own wording must not go further
      // than the bell.
      await notifyUser(expense.userId, 'expense_incomplete', {
        expenseId: expense.id, merchant: expense.merchant, amount: expense.amount, missing,
      }, { email: false });
    }
  } catch (err) {
    logger.error({ err }, 'Missing-details sweep failed');
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startIncompleteSweep(): void {
  if (timer) return;
  setTimeout(() => void runIncompleteSweep(), STARTUP_DELAY_MS);
  timer = setInterval(() => void runIncompleteSweep(), SWEEP_INTERVAL_MS);
  logger.info('Missing-details sweep started (every 5 minutes)');
}
