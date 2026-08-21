import { describe, it, expect } from 'vitest';
import {
  categoryDeleteBlocker,
  matchingCategoryIdSet,
  groupCoaByAccount,
  filterCoaAccounts,
} from './categorySettings';

describe('categoryDeleteBlocker', () => {
  it('allows delete when nothing references the category', () => {
    expect(categoryDeleteBlocker({
      expenses: 0, transactions: 0, children: 0, budgets: 0,
    })).toBeNull();
  });

  it('blocks when child categories still hang off it', () => {
    expect(categoryDeleteBlocker({
      expenses: 0, transactions: 0, children: 2, budgets: 0,
    })).toMatch(/2 child categories/i);
  });

  it('blocks when expenses still use it', () => {
    expect(categoryDeleteBlocker({
      expenses: 12, transactions: 0, children: 0, budgets: 0,
    })).toMatch(/12 expenses/i);
  });

  it('names every remaining reference in one message', () => {
    const msg = categoryDeleteBlocker({
      expenses: 1, transactions: 3, children: 1, budgets: 2,
    });
    expect(msg).toMatch(/child category/i);
    expect(msg).toMatch(/1 expense/i);
    expect(msg).toMatch(/3 transactions/i);
    expect(msg).toMatch(/2 budgets/i);
  });
});

const tree = [
  { id: 'booth', name: 'Booth', parentId: null, description: null as string | null },
  { id: 'space', name: 'Booth space rental fees', parentId: 'booth', description: null },
  { id: 'electric', name: 'Booth electrical charge', parentId: 'booth', description: 'power drop' },
  { id: 'meals', name: 'Meals', parentId: null, description: null },
];

describe('matchingCategoryIdSet', () => {
  it('returns every id when the query is empty', () => {
    expect([...matchingCategoryIdSet(tree, '')].sort()).toEqual(
      ['booth', 'electric', 'meals', 'space'].sort(),
    );
  });

  it('keeps ancestors so a nested hit still has its parent in the tree', () => {
    expect(matchingCategoryIdSet(tree, 'electrical')).toEqual(new Set(['electric', 'booth']));
  });

  it('matches description text', () => {
    expect(matchingCategoryIdSet(tree, 'power drop')).toEqual(new Set(['electric', 'booth']));
  });

  it('returns an empty set when nothing matches', () => {
    expect(matchingCategoryIdSet(tree, 'zzzz')).toEqual(new Set());
  });
});

describe('groupCoaByAccount', () => {
  const accounts = [
    { accountId: 'z-booth', accountName: 'Booth Expense', accountCode: '5100' },
    { accountId: 'z-meals', accountName: 'Meals', accountCode: null },
  ];

  it('attaches many Midas categories to one Zoho account', () => {
    const rows = groupCoaByAccount(accounts, [
      { categoryId: 'space', zohoAccountId: 'z-booth' },
      { categoryId: 'electric', zohoAccountId: 'z-booth' },
    ]);
    expect(rows.find((r) => r.accountId === 'z-booth')?.categoryIds).toEqual(['space', 'electric']);
    expect(rows.find((r) => r.accountId === 'z-meals')?.categoryIds).toEqual([]);
  });

  it('keeps a mapping whose Zoho account is no longer in the live list', () => {
    const rows = groupCoaByAccount(accounts, [
      { categoryId: 'orphan', zohoAccountId: 'z-gone' },
    ]);
    expect(rows.some((r) => r.accountId === 'z-gone' && r.categoryIds.includes('orphan'))).toBe(true);
  });
});

describe('filterCoaAccounts', () => {
  const rows = [
    {
      accountId: 'z-booth',
      accountName: 'Booth Expense',
      accountCode: '5100',
      categoryNames: ['Booth space rental fees', 'Booth electrical charge'],
    },
    {
      accountId: 'z-meals',
      accountName: 'Meals and Entertainment',
      accountCode: null,
      categoryNames: [] as string[],
    },
  ];

  it('matches Zoho account name or code', () => {
    expect(filterCoaAccounts(rows, '5100').map((r) => r.accountId)).toEqual(['z-booth']);
    expect(filterCoaAccounts(rows, 'meals').map((r) => r.accountId)).toEqual(['z-meals']);
  });

  it('matches an attached Midas category name', () => {
    expect(filterCoaAccounts(rows, 'electrical').map((r) => r.accountId)).toEqual(['z-booth']);
  });

  it('returns all rows for an empty query', () => {
    expect(filterCoaAccounts(rows, '  ').map((r) => r.accountId)).toEqual(['z-booth', 'z-meals']);
  });
});
