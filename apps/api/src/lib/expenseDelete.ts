/**
 * Soft-cancel / delete rules for financial transactions.
 * Prefer cancelled over hard delete after submission or Zoho sync.
 */
import type { UserRole } from '@midas/shared';
import { roleAllowed } from './roles';

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
    expenseKind?: string | null;
  };
  force?: boolean;
}): CancelDecision {
  const { role, actorUserId, transaction, force = false } = input;
  const isOwner = transaction.userId === actorUserId;
  const isPrivileged = roleAllowed(role as UserRole, ['accountant', 'admin']);

  if (!isOwner && !isPrivileged) {
    return { ok: false, status: 403, code: 'FORBIDDEN', message: 'Forbidden' };
  }

  const synced =
    !!transaction.zohoRecordId || transaction.integrationStatus === 'synced';

  if (synced) {
    if (roleAllowed(role as UserRole, ['admin']) && force) {
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

  // Partner-kind submit lands directly on 'approved' — there's no accountant
  // review step to pass through, so it never satisfies the 'submitted'/
  // 'pending' branch above. It's still a fresh, un-reviewed, un-synced record;
  // without this the owner would have no way to correct a fat-fingered amount.
  // Gated narrowly to this exact shape (partner kind + never reviewed + no
  // Zoho integration) so a business expense that reaches 'approved' through
  // accountant review — which always sets reviewedAt — keeps its existing
  // rules untouched.
  if (
    transaction.expenseKind === 'partner'
    && transaction.reviewedAt == null
    && transaction.integrationStatus === 'not_required'
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
    expenseKind?: string | null;
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
      expenseKind: input.expense.expenseKind,
    },
  });
}
