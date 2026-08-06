import { describe, expect, it } from 'vitest';
import { partnerExpenseCreateSchema } from '../lib/partnerExpenses';

describe('partnerExpenseCreateSchema', () => {
  it('defaults category to business', () => {
    const parsed = partnerExpenseCreateSchema.parse({ amount: 42.5, itemLocation: 'Dinner — Vegas' });
    expect(parsed.category).toBe('business');
    expect(parsed.amount).toBe(42.5);
  });

  it('accepts personal category', () => {
    const parsed = partnerExpenseCreateSchema.parse({ amount: 10, itemLocation: 'Gift shop', category: 'personal' });
    expect(parsed.category).toBe('personal');
  });

  it('trims itemLocation and rejects empty', () => {
    expect(partnerExpenseCreateSchema.parse({ amount: 1, itemLocation: '  Uber  ' }).itemLocation).toBe('Uber');
    expect(() => partnerExpenseCreateSchema.parse({ amount: 1, itemLocation: '   ' })).toThrow();
  });

  it('rejects zero, negative, and non-numeric amounts', () => {
    expect(() => partnerExpenseCreateSchema.parse({ amount: 0, itemLocation: 'x' })).toThrow();
    expect(() => partnerExpenseCreateSchema.parse({ amount: -5, itemLocation: 'x' })).toThrow();
    expect(() => partnerExpenseCreateSchema.parse({ amount: 'abc', itemLocation: 'x' })).toThrow();
  });
});
