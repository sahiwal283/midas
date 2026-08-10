/**
 * Closed accounting periods — pure helpers (no env/db imports).
 *
 * A period is a calendar month written 'YYYY-MM'. Expenses whose date falls in
 * a closed period are locked: no edits, deletes, submits, reviews, or
 * reimbursement changes (admin force-delete is the audited override).
 * Corrections happen via the rejected-clone flow into an open period.
 */

/** 'YYYY-MM' with a valid month. */
export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** periodOf('2026-08-04') → '2026-08' */
export function periodOf(date: string): string {
  return date.slice(0, 7);
}

/** True when the expense date's month is in the closed-period list. */
export function isInClosedPeriods(date: string, periods: string[]): boolean {
  return periods.includes(periodOf(date));
}

/** Canonical 409 PERIOD_CLOSED message. */
export function closedPeriodMessage(period: string): string {
  return `This expense falls in a closed accounting period (${period}).`;
}
