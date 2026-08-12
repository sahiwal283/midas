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

  // Partner submit lands directly on 'approved' with no accountant review —
  // the owner still needs a way to correct a fat-fingered amount.
  describe('partner-kind terminal state (approved, never reviewed, no Zoho)', () => {
    const partnerRecorded = {
      ...base,
      status: 'approved',
      integrationStatus: 'not_required',
      expenseKind: 'partner',
    };

    it('allows the owner to soft-cancel', () => {
      const d = canSessionDeleteExpense({
        role: 'partner',
        actorUserId: 'u1',
        expense: partnerRecorded,
      });
      expect(d.ok).toBe(true);
      if (d.ok) expect(d.mode).toBe('soft_cancel');
    });

    it('still blocks a non-owner, non-privileged actor', () => {
      const d = canSessionDeleteExpense({
        role: 'partner',
        actorUserId: 'someone-else',
        expense: partnerRecorded,
      });
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.status).toBe(403);
    });

    it('does NOT loosen the rule for a business-kind approved expense (guard against over-widening)', () => {
      const d = canSessionDeleteExpense({
        role: 'user',
        actorUserId: 'u1',
        expense: { ...base, status: 'approved', integrationStatus: 'not_required', expenseKind: 'business' },
      });
      expect(d.ok).toBe(false);
    });

    it('does NOT apply once the row has been reviewed (reviewedAt set)', () => {
      const d = canSessionDeleteExpense({
        role: 'partner',
        actorUserId: 'u1',
        expense: { ...partnerRecorded, reviewedAt: new Date() },
      });
      expect(d.ok).toBe(false);
    });

    it('does NOT apply once the row is Zoho-synced', () => {
      const d = canSessionDeleteExpense({
        role: 'partner',
        actorUserId: 'u1',
        expense: { ...partnerRecorded, integrationStatus: 'synced' },
      });
      expect(d.ok).toBe(false);
    });
  });
});
