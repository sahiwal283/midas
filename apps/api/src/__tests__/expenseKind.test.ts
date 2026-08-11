import { describe, it, expect } from 'vitest';
import { resolveExpenseKind, isPartnerExpense } from '../lib/expenseKind';

describe('resolveExpenseKind', () => {
  it('lets a partner mark an expense as partner spend', () => {
    expect(resolveExpenseKind('partner', 'partner')).toBe('partner');
  });

  it('lets a developer mark partner spend (developer passes every gate)', () => {
    expect(resolveExpenseKind('partner', 'developer')).toBe('partner');
  });

  it('coerces to business for non-partner roles even if the client asks for partner', () => {
    expect(resolveExpenseKind('partner', 'user')).toBe('business');
    expect(resolveExpenseKind('partner', 'accountant')).toBe('business');
    expect(resolveExpenseKind('partner', 'admin')).toBe('business');
  });

  it('defaults to business when nothing is requested', () => {
    expect(resolveExpenseKind(undefined, 'partner')).toBe('business');
    expect(resolveExpenseKind(null, 'partner')).toBe('business');
  });

  it('rejects unknown values rather than passing them through', () => {
    expect(resolveExpenseKind('nonsense', 'partner')).toBe('business');
  });
});

describe('isPartnerExpense', () => {
  it('is true only for partner kind', () => {
    expect(isPartnerExpense({ expenseKind: 'partner' })).toBe(true);
    expect(isPartnerExpense({ expenseKind: 'business' })).toBe(false);
    expect(isPartnerExpense({})).toBe(false);
    expect(isPartnerExpense({ expenseKind: null })).toBe(false);
  });
});
