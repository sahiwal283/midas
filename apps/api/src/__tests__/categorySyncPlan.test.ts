import { describe, expect, it } from 'vitest';
import { planCategorySync } from '../lib/categorySyncPlan';

const accounts = [
  { accountId: 'z-1', accountName: 'Warehouse Supplies' },
  { accountId: 'z-2', accountName: 'Office Supplies' },
  { accountId: 'z-3', accountName: 'Meals and Entertainment' },
];

describe('planCategorySync', () => {
  it('creates categories for unknown accounts and maps matches by name (case-insensitive)', () => {
    const existing = [
      { id: 'c-office', name: 'office supplies' },
      { id: 'c-meals', name: 'Meals and Entertainment' },
    ];
    const plan = planCategorySync(existing, accounts, new Map());
    expect(plan.create).toEqual([{ name: 'Warehouse Supplies', accountId: 'z-1' }]);
    expect(plan.map).toEqual(expect.arrayContaining([
      { categoryId: 'c-office', accountId: 'z-2' },
      { categoryId: 'c-meals', accountId: 'z-3' },
    ]));
  });

  it('never overwrites an existing mapping for the company', () => {
    const existing = [{ id: 'c-office', name: 'Office Supplies' }];
    const alreadyMapped = new Map([['c-office', 'z-existing']]);
    const plan = planCategorySync(existing, accounts, alreadyMapped);
    expect(plan.map.find((m) => m.categoryId === 'c-office')).toBeUndefined();
  });

  it('is idempotent: everything known and mapped → empty plan', () => {
    const existing = [
      { id: 'c-wh', name: 'Warehouse Supplies' },
      { id: 'c-office', name: 'Office Supplies' },
      { id: 'c-meals', name: 'Meals and Entertainment' },
    ];
    const mapped = new Map([['c-wh', 'z-1'], ['c-office', 'z-2'], ['c-meals', 'z-3']]);
    const plan = planCategorySync(existing, accounts, mapped);
    expect(plan.create).toEqual([]);
    expect(plan.map).toEqual([]);
  });

  it('trims whitespace when matching names', () => {
    const existing = [{ id: 'c-wh', name: ' Warehouse Supplies ' }];
    const plan = planCategorySync(existing, accounts, new Map());
    expect(plan.create.find((c) => c.name === 'Warehouse Supplies')).toBeUndefined();
    expect(plan.map).toEqual(expect.arrayContaining([{ categoryId: 'c-wh', accountId: 'z-1' }]));
  });
});
