import { describe, expect, it } from 'vitest';

/** Mirrors DELETE rules in routes/ext.ts (docs/EXT_API_MERGE_LOCK.md B7). */
function canExtDelete(expense: {
  status: string;
  reviewedAt: Date | null;
  zohoExpenseId: string | null;
}): boolean {
  return (
    expense.status === 'draft'
    || (expense.status === 'pending' && expense.reviewedAt == null && expense.zohoExpenseId == null)
  );
}

describe('Ext DELETE rules', () => {
  it('allows draft', () => {
    expect(canExtDelete({ status: 'draft', reviewedAt: null, zohoExpenseId: null })).toBe(true);
  });

  it('allows pending unreviewed without Zoho id', () => {
    expect(canExtDelete({ status: 'pending', reviewedAt: null, zohoExpenseId: null })).toBe(true);
  });

  it('blocks pending with Zoho id', () => {
    expect(canExtDelete({ status: 'pending', reviewedAt: null, zohoExpenseId: 'z-1' })).toBe(false);
  });

  it('blocks pending after review', () => {
    expect(canExtDelete({ status: 'pending', reviewedAt: new Date(), zohoExpenseId: null })).toBe(false);
  });

  it('blocks approved', () => {
    expect(canExtDelete({ status: 'approved', reviewedAt: null, zohoExpenseId: null })).toBe(false);
  });
});
