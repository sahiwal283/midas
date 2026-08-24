import { describe, it, expect } from 'vitest';
import {
  groupPaymentMethodsForCompany,
  patchForCompanyMove,
  countCardsPerZohoAccount,
  shareHintFor,
} from './paymentMethodGroups';

function pm(id: string, entity: string | null) {
  return { id, defaultZohoEntity: entity, zohoAccountName: null as string | null };
}

describe('groupPaymentMethodsForCompany', () => {
  const rows = [
    pm('haute-amex', 'Haute Brands'),
    pm('boomin-cap', 'Boomin Brands'),
    pm('personal', null),
    pm('empty', ''),
  ];

  it('keeps the selected company and unassigned cards; hides other companies', () => {
    const { belonging, unassigned } = groupPaymentMethodsForCompany(rows, 'Haute Brands');
    expect(belonging.map((r) => r.id)).toEqual(['haute-amex']);
    expect(unassigned.map((r) => r.id)).toEqual(['personal', 'empty']);
  });

  it('does not leak another company into belonging', () => {
    const { belonging } = groupPaymentMethodsForCompany(rows, 'Boomin Brands');
    expect(belonging.map((r) => r.id)).toEqual(['boomin-cap']);
  });
});

describe('patchForCompanyMove', () => {
  it('clears a Zoho paid-through mapping when the company changes', () => {
    expect(patchForCompanyMove(
      { defaultZohoEntity: 'Boomin Brands', zohoAccountName: '4849' },
      'Haute Brands',
    )).toEqual({ defaultZohoEntity: 'Haute Brands', zohoAccountName: null });
  });

  it('does not touch Zoho mapping when the company is unchanged', () => {
    expect(patchForCompanyMove(
      { defaultZohoEntity: 'Haute Brands', zohoAccountName: '4849' },
      'Haute Brands',
    )).toEqual({ defaultZohoEntity: 'Haute Brands' });
  });

  it('moves a card to unassigned and clears a Zoho mapping', () => {
    expect(patchForCompanyMove(
      { defaultZohoEntity: 'Haute Brands', zohoAccountName: '4849' },
      '',
    )).toEqual({ defaultZohoEntity: null, zohoAccountName: null });
  });
});

describe('countCardsPerZohoAccount', () => {
  it('counts several cards sharing one account', () => {
    const counts = countCardsPerZohoAccount([
      { zohoAccountName: 'acct-pnc-credit' },
      { zohoAccountName: 'acct-pnc-credit' },
      { zohoAccountName: 'acct-pnc-credit' },
      { zohoAccountName: 'acct-checking' },
    ]);
    expect(counts.get('acct-pnc-credit')).toBe(3);
    expect(counts.get('acct-checking')).toBe(1);
  });

  it('ignores unmapped cards', () => {
    const counts = countCardsPerZohoAccount([
      { zohoAccountName: null },
      { zohoAccountName: '' },
      { zohoAccountName: 'acct-a' },
    ]);
    expect(counts.get('acct-a')).toBe(1);
    expect(counts.size).toBe(1);
  });

  it('returns an empty map for no cards', () => {
    expect(countCardsPerZohoAccount([]).size).toBe(0);
  });
});

describe('shareHintFor', () => {
  const counts = new Map([['acct-shared', 3], ['acct-solo', 1]]);

  it('describes the other cards already on a shared account', () => {
    expect(shareHintFor(counts, 'acct-shared', null)).toBe('already on 3 cards');
  });

  it('says nothing for an account no card uses', () => {
    expect(shareHintFor(counts, 'acct-free', null)).toBeNull();
  });

  it('says nothing when the only card on it is the one being edited', () => {
    expect(shareHintFor(counts, 'acct-solo', 'acct-solo')).toBeNull();
  });

  it('excludes the current card from the count it reports', () => {
    expect(shareHintFor(counts, 'acct-shared', 'acct-shared')).toBe('also on 2 other cards');
  });

  it('uses the singular form for a single other card', () => {
    expect(shareHintFor(new Map([['a', 2]]), 'a', 'a')).toBe('also on 1 other card');
    expect(shareHintFor(new Map([['a', 1]]), 'a', null)).toBe('already on 1 card');
  });
});
