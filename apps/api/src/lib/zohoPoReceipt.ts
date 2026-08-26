// A purchase order whose receipt did not reach Zoho.
//
// The Books record exists either way, so a failed attach must never look like
// a failed push — re-pushing would duplicate the PO. It marks the row instead,
// mirroring the expense-side rule added in v1.3.2 after receipts silently
// stopped reaching Zoho for three weeks.

const PREFIX = '[RECEIPT_WARNING] ';
const MAX = 500;

export function poReceiptWarning(problem: string | null): string | null {
  if (!problem) return null;
  return `${PREFIX}${problem}`.slice(0, MAX);
}

/**
 * Gate for attempting a receipt attach after a PO push. Mirrors the
 * expense-side guard (`zohoPush.ts`: `if (result.zohoExpenseId && !result.dryRun)`).
 * ZOHO_DRY_RUN defaults to true, so without this check every dry-run push
 * would call the (always-false-returning) attach client and get stamped with
 * a "Zoho rejected the receipt upload" warning for a receipt that was never
 * attempted. Pulled out as a pure predicate so the condition itself — not
 * just its consequences — is covered by a DB-free test.
 */
export function shouldAttemptPoReceiptAttach(
  zohoPurchaseOrderId: string | null | undefined,
  dryRun: boolean | undefined,
): boolean {
  return Boolean(zohoPurchaseOrderId) && !dryRun;
}
