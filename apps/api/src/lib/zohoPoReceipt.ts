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

/**
 * What became of the PO's receipt during a real (non-dry-run) push.
 *
 * `none` is the case the first cut of this feature missed: with no receipt at
 * all there was nothing to attach, so nothing was flagged and the PO rendered
 * as a clean "Created". Spec Decision 6 says a receipt-less PO pushes *and is
 * flagged* — the expense-side `missing_receipt` flag cannot cover it, because
 * that flag's subquery keys on `receipts.expense_id`, which a PO receipt never
 * has.
 */
export type PoReceiptOutcome =
  | { kind: 'attached' }
  | { kind: 'none' }
  | { kind: 'rejected' }
  | { kind: 'unreadable'; storagePath: string };

/**
 * Map a receipt outcome to the problem text that goes into the warning, or
 * null when there is nothing to warn about. Pure so the "no receipt is still a
 * warning" rule is covered without a database or a Zoho client.
 */
export function poReceiptProblem(outcome: PoReceiptOutcome): string | null {
  switch (outcome.kind) {
    case 'attached':
      return null;
    case 'none':
      return 'purchase order pushed with no receipt';
    case 'rejected':
      return 'Zoho rejected the receipt upload';
    case 'unreadable':
      return `receipt file could not be read (${outcome.storagePath})`;
  }
}
