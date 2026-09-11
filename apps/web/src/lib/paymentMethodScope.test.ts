import { describe, it, expect } from 'vitest';

import { cardsForCompany } from './paymentMethodScope';

const HAUTE = { id: 'a', label: 'Haute Amex', defaultZohoEntity: 'Haute Brands' };
const BOOMIN = { id: 'b', label: 'Boomin Visa', defaultZohoEntity: 'Boomin Brands' };
const UNASSIGNED = { id: 'c', label: 'Personal card', defaultZohoEntity: null };

describe('cardsForCompany', () => {
  it('keeps only the selected company’s cards', () => {
    expect(cardsForCompany([HAUTE, BOOMIN], 'Boomin Brands')).toEqual([BOOMIN]);
  });

  // A card with no company set is usually a personal / out-of-pocket card that
  // crosses brands. Hiding it would strand the employee who has to use it.
  it('keeps cards with no company alongside the matches', () => {
    expect(cardsForCompany([HAUTE, BOOMIN, UNASSIGNED], 'Haute Brands')).toEqual([HAUTE, UNASSIGNED]);
  });

  it('matches the company name case- and whitespace-insensitively', () => {
    expect(cardsForCompany([HAUTE, BOOMIN], '  haute brands ')).toEqual([HAUTE]);
  });

  // Before a company is picked the field is gated, but the list still renders —
  // returning everything keeps the gate the thing that blocks, not a silent
  // empty dropdown.
  it('returns every card when no company is selected', () => {
    expect(cardsForCompany([HAUTE, BOOMIN, UNASSIGNED], '')).toEqual([HAUTE, BOOMIN, UNASSIGNED]);
  });

  // A card the form already holds must stay visible, or the select renders
  // blank over a value that is still in state.
  it('keeps the already-selected card even when it belongs elsewhere', () => {
    expect(cardsForCompany([HAUTE, BOOMIN], 'Haute Brands', 'b')).toEqual([HAUTE, BOOMIN]);
  });

  it('does not duplicate the selected card when it already matches', () => {
    expect(cardsForCompany([HAUTE, BOOMIN], 'Haute Brands', 'a')).toEqual([HAUTE]);
  });

  it('preserves the incoming order', () => {
    expect(cardsForCompany([UNASSIGNED, BOOMIN, HAUTE], 'Boomin Brands')).toEqual([UNASSIGNED, BOOMIN]);
  });
});

describe('cardBelongsToCompany', () => {
  it('is false only for a card explicitly owned by another company', async () => {
    const { cardBelongsToCompany } = await import('./paymentMethodScope');
    expect(cardBelongsToCompany(BOOMIN, 'Haute Brands')).toBe(false);
    expect(cardBelongsToCompany(HAUTE, 'Haute Brands')).toBe(true);
    expect(cardBelongsToCompany(UNASSIGNED, 'Haute Brands')).toBe(true);
    expect(cardBelongsToCompany(BOOMIN, '')).toBe(true);
  });
});
