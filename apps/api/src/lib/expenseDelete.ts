/** Session-auth rules for deleting expenses (web UI / accountant cleanup). */

export type DeleteDecision =
  | { ok: true }
  | { ok: false; status: 403 | 409; code: string; message: string };

export function canSessionDeleteExpense(input: {
  role: string;
  actorUserId: string;
  expense: {
    userId: string;
    status: string;
    reviewedAt: Date | null;
    zohoExpenseId: string | null;
  };
  force?: boolean;
}): DeleteDecision {
  const { role, actorUserId, expense, force = false } = input;
  const isOwner = expense.userId === actorUserId;
  const isPrivileged = role === 'accountant' || role === 'admin';

  if (!isOwner && !isPrivileged) {
    return { ok: false, status: 403, code: 'FORBIDDEN', message: 'Forbidden' };
  }

  if (expense.zohoExpenseId) {
    if (role === 'admin' && force) return { ok: true };
    return {
      ok: false,
      status: 409,
      code: 'CONFLICT',
      message: 'Expense is linked to Zoho. Admin force delete is required.',
    };
  }

  if (isPrivileged) return { ok: true };

  // Owner: draft always; pending only if never reviewed
  if (expense.status === 'draft') return { ok: true };
  if (expense.status === 'pending' && expense.reviewedAt == null) return { ok: true };

  return {
    ok: false,
    status: 409,
    code: 'CONFLICT',
    message: 'Only draft or unreviewed pending expenses can be deleted by the owner',
  };
}
