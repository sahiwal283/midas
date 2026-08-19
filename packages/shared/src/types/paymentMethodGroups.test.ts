import { describe, it, expect } from 'vitest';
import { groupPaymentMethodsForCompany, patchForCompanyMove } from './paymentMethodGroups';

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
