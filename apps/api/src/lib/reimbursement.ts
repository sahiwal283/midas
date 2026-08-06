/** Personal / out-of-pocket cards that require employee reimbursement. */

export function paymentMethodRequiresReimbursement(pm: {
  requiresReimbursement?: boolean | null;
  label?: string | null;
} | null | undefined): boolean {
  if (!pm) return false;
  if (pm.requiresReimbursement) return true;
  const label = (pm.label ?? '').toLowerCase();
  return label.includes('personal') && (label.includes('reimburs') || label.includes('need'));
}

/**
 * When an expense is tied to a reimbursable card and reimbursement was never
 * requested, promote to `pending` so accountants see it in the Reimbursement lane.
 */
export function nextReimbursementOnCardLink(
  current: string,
  pm: { requiresReimbursement?: boolean | null; label?: string | null } | null | undefined,
): string | null {
  if (!paymentMethodRequiresReimbursement(pm)) return null;
  if (current === 'not_requested') return 'pending';
  return null;
}
