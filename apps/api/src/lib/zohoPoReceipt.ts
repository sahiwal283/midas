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
