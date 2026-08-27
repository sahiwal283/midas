import { describe, expect, it } from 'vitest';
import { pickCategoryAccountId } from '../lib/categoryAccountPick';

// Zoho account ids are org-scoped: every Haute Brands account starts 5254962,
// Nirvana 2212769, Boomin 4849689. The legacy expense_categories.zoho_account_id
// column is entity-agnostic, so falling back to it can hand one org's account to
// another org — Zoho then rejects the push with "Please enter valid expense
// account", which is exactly what happened to three prod expenses.
const HAUTE = '5254962000000000448';
const NIRVANA = '2212769000000000448';

describe('pickCategoryAccountId', () => {
  it('prefers the per-entity mapping over the legacy column', () => {
    expect(pickCategoryAccountId({
      chain: ['cat-1'],
      perEntity: new Map([['cat-1', NIRVANA]]),
      legacyById: new Map([['cat-1', HAUTE]]),
      companyAccountIds: [NIRVANA],
    })).toBe(NIRVANA);
  });

  it('refuses a legacy account belonging to a different Zoho org', () => {
    expect(pickCategoryAccountId({
      chain: ['cat-1'],
      perEntity: new Map(),
      legacyById: new Map([['cat-1', HAUTE]]),
      companyAccountIds: [NIRVANA],
    })).toBeNull();
  });

  it('accepts a legacy account that matches the company org', () => {
    expect(pickCategoryAccountId({
      chain: ['cat-1'],
      perEntity: new Map(),
      legacyById: new Map([['cat-1', HAUTE]]),
      companyAccountIds: ['5254962000001346011'],
    })).toBe(HAUTE);
  });

  it('keeps the legacy fallback when the company org cannot be established', () => {
    expect(pickCategoryAccountId({
      chain: ['cat-1'],
      perEntity: new Map(),
      legacyById: new Map([['cat-1', HAUTE]]),
      companyAccountIds: [],
    })).toBe(HAUTE);
  });

  it('inherits up the ancestry chain', () => {
    expect(pickCategoryAccountId({
      chain: ['child', 'parent'],
      perEntity: new Map([['parent', NIRVANA]]),
      legacyById: new Map(),
      companyAccountIds: [NIRVANA],
    })).toBe(NIRVANA);
  });
});
