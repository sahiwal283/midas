/** Guard rules for admin user deletion and role changes. */

export type UserAdminDecision =
  | { ok: true }
  | { ok: false; status: 400 | 409; code: string; message: string };

export interface OwnedCounts {
  expenses: number;
  receipts: number;
  messages: number;
  captures: number;
}

export function canDeleteUser(i: {
  actorId: string;
  targetId: string;
  targetRole: string;
  targetIsActive: boolean;
  activeAdminCount: number;
}): UserAdminDecision {
  if (i.actorId === i.targetId) {
    return { ok: false, status: 400, code: 'SELF_DELETE', message: 'You cannot delete your own account' };
  }
  if (i.targetRole === 'admin' && i.targetIsActive && i.activeAdminCount <= 1) {
    return { ok: false, status: 400, code: 'LAST_ADMIN', message: 'Cannot delete the last active admin' };
  }
  return { ok: true };
}

export function canChangeRole(i: {
  actorId: string;
  targetId: string;
  targetRole: string;
  newRole: string;
  targetIsActive: boolean;
  activeAdminCount: number;
}): UserAdminDecision {
  if (i.actorId === i.targetId) {
    return { ok: false, status: 400, code: 'SELF_ROLE_CHANGE', message: 'You cannot change your own role' };
  }
  if (
    i.targetRole === 'admin' && i.newRole !== 'admin'
    && i.targetIsActive && i.activeAdminCount <= 1
  ) {
    return { ok: false, status: 400, code: 'LAST_ADMIN', message: 'Cannot demote the last active admin' };
  }
  return { ok: true };
}

export function hasOwnedData(c: OwnedCounts): boolean {
  return c.expenses > 0 || c.receipts > 0 || c.messages > 0 || c.captures > 0;
}
