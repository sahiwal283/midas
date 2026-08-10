import { describe, expect, it } from 'vitest';
import { canSessionDeleteExpense } from '../lib/expenseDelete';

const base = {
  userId: 'u1',
  status: 'pending',
  reviewedAt: null as Date | null,
  zohoExpenseId: null as string | null,
};

describe('canSessionDeleteExpense', () => {
  it('allows owner draft as hard delete', () => {
    const d = canSessionDeleteExpense({
      role: 'user',
      actorUserId: 'u1',
      expense: { ...base, status: 'draft' },
    });
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.mode).toBe('hard_delete');
  });

  it('allows owner unreviewed pending as soft cancel', () => {
    const d = canSessionDeleteExpense({
      role: 'user',
      actorUserId: 'u1',
      expense: base,
    });
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.mode).toBe('soft_cancel');
  });

  it('blocks owner approved', () => {
    const d = canSessionDeleteExpense({
      role: 'user',
      actorUserId: 'u1',
      expense: { ...base, status: 'approved' },
    });
    expect(d.ok).toBe(false);
  });

  it('allows accountant soft-cancel without Zoho', () => {
    const d = canSessionDeleteExpense({
      role: 'accountant',
      actorUserId: 'a1',
      expense: { ...base, status: 'approved', userId: 'u1' },
    });
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.mode).toBe('soft_cancel');
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

  it('allows admin force soft-cancel for Zoho-linked', () => {
    const d = canSessionDeleteExpense({
      role: 'admin',
      actorUserId: 'admin',
      expense: { ...base, zohoExpenseId: 'z-1' },
      force: true,
    });
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.mode).toBe('soft_cancel');
  });
});
