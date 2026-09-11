import { describe, it, expect, vi } from 'vitest';

// The helper is pure, but its module pulls in `db` — mock env so importing it
// does not demand a real DATABASE_URL (same pattern as companyZoho.test.ts).
vi.mock('../config/env', () => ({
  env: { DATABASE_URL: 'postgresql://test:test@localhost:5432/test' },
}));

import { accountColumnsForCompanyChange } from '../lib/categoryZohoAccounts';

describe('accountColumnsForCompanyChange', () => {
  // The stored account id wins over the freshly resolved one when the payload
  // is built (see zohoPayload), so an id resolved against the old company would
  // otherwise survive the move and file the expense in the wrong brand's books.
  it('re-resolves the account for the new company', () => {
    expect(accountColumnsForCompanyChange({
      categoryId: 'cat-1',
      categoryName: 'Meals and Entertainment',
      resolvedAccountId: '99887766',
    })).toEqual({
      zohoExpenseAccountId: '99887766',
      zohoExpenseAccountName: 'Meals and Entertainment',
    });
  });

  // No mapping for this category in the new company's chart of accounts. The
  // stored id must still go: a push that resolves nothing fails loudly, where a
  // stale id files the expense under another brand's account silently.
  it('clears the stored account when the new company has no mapping', () => {
    expect(accountColumnsForCompanyChange({
      categoryId: 'cat-1',
      categoryName: 'Meals and Entertainment',
      resolvedAccountId: null,
    })).toEqual({
      zohoExpenseAccountId: null,
      zohoExpenseAccountName: 'Meals and Entertainment',
    });
  });

  // Nothing to resolve from, so nothing may be kept either.
  it('clears both columns when the expense has no category', () => {
    expect(accountColumnsForCompanyChange({
      categoryId: null,
      categoryName: null,
      resolvedAccountId: null,
    })).toEqual({
      zohoExpenseAccountId: null,
      zohoExpenseAccountName: null,
    });
  });
});
