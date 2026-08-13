import { isAutoPushEligible } from './autoApprove';

/**
 * Daily expenses (staff-entered, business kind, Zoho-enabled company) skip
 * accountant review once complete. This module owns the pure rules for the
 * "completed after submission" path; the db orchestration lives in
 * pendingCompletionDb.ts (same split as closedPeriods/closedPeriodsDb).
 */

export function isDailyAutoPushCandidate(i: {
  sourceApp: string | null;
  expenseKind: string;
  companyZohoEnabled?: boolean;
}): boolean {
  if (i.expenseKind === 'partner') return false;
  // Delegate source/company rules to the canonical eligibility check.
  return isAutoPushEligible({ sourceApp: i.sourceApp, ready: true, companyZohoEnabled: i.companyZohoEnabled });
}

/** System message posted on the expense when it is submitted incomplete. */
export function incompleteSubmissionMessage(missing: string[]): string {
  const list = missing.join(', ');
  return `This expense is missing: ${list}. `
    + 'Add the missing item(s) and it will be approved and sent to accounting automatically — no accountant review needed.';
}
