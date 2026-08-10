/**
 * Soft-cancel / delete rules for financial transactions.
 * Prefer cancelled over hard delete after submission or Zoho sync.
 */

export type CancelDecision =
  | { ok: true; mode: 'hard_delete' | 'soft_cancel' }
  | { ok: false; status: 403 | 409; code: string; message: string };

export function canCancelOrDeleteTransaction(input: {
  role: string;
  actorUserId: string;
  transaction: {
    userId: string;
    status: string;
    reviewedAt: Date | null;
    zohoRecordId: string | null;
    integrationStatus: string;
  };
  force?: boolean;
}): CancelDecision {
  const { role, actorUserId, transaction, force = false } = input;
  const isOwner = transaction.userId === actorUserId;
  const isPrivileged = role === 'accountant' || role === 'admin';

  if (!isOwner && !isPrivileged) {
    return { ok: false, status: 403, code: 'FORBIDDEN', message: 'Forbidden' };
  }

  const synced =
    !!transaction.zohoRecordId || transaction.integrationStatus === 'synced';

  if (synced) {
    if (role === 'admin' && force) {
      return { ok: true, mode: 'soft_cancel' };
    }
    return {
      ok: false,
      status: 409,
      code: 'SYNCED_IMMUTABLE',
      message: 'Synced financial records cannot be deleted. Cancel is admin-only with force.',
    };
  }

  // Draft: hard delete allowed
  if (transaction.status === 'draft') {
    return { ok: true, mode: 'hard_delete' };
  }

  // Submitted / pending equivalent never reviewed: owner may soft-cancel
  if (
    (transaction.status === 'submitted' || transaction.status === 'pending')
    && transaction.reviewedAt == null
  ) {
    if (isOwner || isPrivileged) {
      return { ok: true, mode: 'soft_cancel' };
    }
  }

  if (isPrivileged) {
    return { ok: true, mode: 'soft_cancel' };
  }

  return {
    ok: false,
    status: 409,
    code: 'CONFLICT',
    message: 'Only draft transactions can be permanently deleted; submitted records must be cancelled',
  };
}

/** Legacy expense wrapper — maps expense fields into cancel rules. */
export function canSessionDeleteExpense(input: {
  role: string;
  actorUserId: string;
  expense: {
    userId: string;
    status: string;
    reviewedAt: Date | null;
    zohoExpenseId: string | null;
    integrationStatus?: string | null;
  };
  force?: boolean;
}): CancelDecision {
  const status =
    input.expense.status === 'pending' ? 'submitted' : input.expense.status;

  return canCancelOrDeleteTransaction({
    role: input.role,
    actorUserId: input.actorUserId,
    force: input.force,
    transaction: {
      userId: input.expense.userId,
      status,
      reviewedAt: input.expense.reviewedAt,
      zohoRecordId: input.expense.zohoExpenseId,
      integrationStatus: input.expense.integrationStatus ?? (input.expense.zohoExpenseId ? 'synced' : 'not_required'),
    },
  });
}
