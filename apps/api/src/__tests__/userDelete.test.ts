import { describe, expect, it } from 'vitest';
import { canDeleteUser, canChangeRole, hasOwnedData } from '../lib/userDelete';

const base = { actorId: 'a1', targetId: 't1', targetRole: 'user', targetIsActive: true, activeAdminCount: 2 };

describe('canDeleteUser', () => {
  it('allows deleting a regular user', () => {
    expect(canDeleteUser(base)).toEqual({ ok: true });
  });

  it('blocks self-delete', () => {
    const d = canDeleteUser({ ...base, targetId: 'a1' });
    expect(d).toMatchObject({ ok: false, status: 400, code: 'SELF_DELETE' });
  });

  it('blocks deleting the last active admin', () => {
    const d = canDeleteUser({ ...base, targetRole: 'admin', activeAdminCount: 1 });
    expect(d).toMatchObject({ ok: false, status: 400, code: 'LAST_ADMIN' });
  });

  it('allows deleting an admin when another active admin remains', () => {
    expect(canDeleteUser({ ...base, targetRole: 'admin', activeAdminCount: 2 })).toEqual({ ok: true });
  });

  it('allows deleting an inactive admin even if admin count is 1', () => {
    expect(canDeleteUser({ ...base, targetRole: 'admin', targetIsActive: false, activeAdminCount: 1 })).toEqual({ ok: true });
  });
});

describe('canChangeRole', () => {
  it('allows promoting a user to partner', () => {
    expect(canChangeRole({ ...base, newRole: 'partner' })).toEqual({ ok: true });
  });

  it('blocks changing your own role', () => {
    const d = canChangeRole({ ...base, targetId: 'a1', newRole: 'user' });
    expect(d).toMatchObject({ ok: false, status: 400, code: 'SELF_ROLE_CHANGE' });
  });

  it('blocks demoting the last active admin', () => {
    const d = canChangeRole({ ...base, targetRole: 'admin', newRole: 'user', activeAdminCount: 1 });
    expect(d).toMatchObject({ ok: false, status: 400, code: 'LAST_ADMIN' });
  });

  it('allows admin → admin no-op and demotion when another admin exists', () => {
    expect(canChangeRole({ ...base, targetRole: 'admin', newRole: 'admin', activeAdminCount: 1 })).toEqual({ ok: true });
    expect(canChangeRole({ ...base, targetRole: 'admin', newRole: 'user', activeAdminCount: 2 })).toEqual({ ok: true });
  });
});

describe('hasOwnedData', () => {
  it('false when all counts are zero', () => {
    expect(hasOwnedData({ expenses: 0, receipts: 0, messages: 0, captures: 0 })).toBe(false);
  });
  it('true when any count is nonzero', () => {
    expect(hasOwnedData({ expenses: 0, receipts: 0, messages: 1, captures: 0 })).toBe(true);
  });
});
