import { describe, expect, it } from 'vitest';
import { canSessionDeleteExpense } from '../lib/expenseDelete';

const base = {
  userId: 'u1',
  status: 'pending',
  reviewedAt: null as Date | null,
  zohoExpenseId: null as string | null,
};

describe('canSessionDeleteExpense', () => {
  it('allows owner draft', () => {
    expect(
      canSessionDeleteExpense({
        role: 'user',
        actorUserId: 'u1',
        expense: { ...base, status: 'draft' },
      }).ok,
    ).toBe(true);
  });

  it('allows owner unreviewed pending without Zoho', () => {
    expect(
      canSessionDeleteExpense({
        role: 'user',
        actorUserId: 'u1',
        expense: base,
      }).ok,
    ).toBe(true);
  });

  it('blocks owner approved', () => {
    const d = canSessionDeleteExpense({
      role: 'user',
      actorUserId: 'u1',
      expense: { ...base, status: 'approved' },
    });
    expect(d.ok).toBe(false);
  });

  it('allows accountant without Zoho', () => {
    expect(
      canSessionDeleteExpense({
        role: 'accountant',
        actorUserId: 'a1',
        expense: { ...base, status: 'approved', userId: 'u1' },
      }).ok,
    ).toBe(true);
  });

  it('blocks Zoho-linked without admin force', () => {
    const d = canSessionDeleteExpense({
      role: 'accountant',
      actorUserId: 'a1',
      expense: { ...base, zohoExpenseId: 'z-1' },
      force: true,
    });
    expect(d.ok).toBe(false);
  });

  it('allows admin force for Zoho-linked', () => {
    expect(
      canSessionDeleteExpense({
        role: 'admin',
        actorUserId: 'admin',
        expense: { ...base, zohoExpenseId: 'z-1' },
        force: true,
      }).ok,
    ).toBe(true);
  });
});
