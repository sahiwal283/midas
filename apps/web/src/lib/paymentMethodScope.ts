/**
 * Company scoping for the payment-method pickers.
 *
 * A card belongs to one company (`defaultZohoEntity`), and an expense charged
 * to one company must not be paid on another company's card — the Zoho push
 * would file the payment against the wrong org's account. Cards with no
 * company set are usually personal / out-of-pocket cards that cross brands, so
 * they stay selectable everywhere rather than becoming unreachable.
 */

export interface ScopedCard {
  defaultZohoEntity?: string | null;
}

function sameCompany(a: string | null | undefined, b: string): boolean {
  return (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();
}

/** True unless the card is explicitly owned by a different company. */
export function cardBelongsToCompany<T extends ScopedCard>(card: T, company: string): boolean {
  if (!company.trim()) return true;
  if (!card.defaultZohoEntity?.trim()) return true;
  return sameCompany(card.defaultZohoEntity, company);
}

/**
 * The cards selectable for `company`, in the order they came in.
 *
 * `keepId` is the card already selected: it stays in the list even when it
 * belongs to another company. A <select> holding a value that is not among its
 * options renders blank while state still holds the old card — the selection
 * would then change by omission on the next save rather than by a decision.
 */
export function cardsForCompany<T extends ScopedCard & { id: string }>(
  cards: T[],
  company: string,
  keepId?: string | null,
): T[] {
  if (!company.trim()) return cards;
  return cards.filter((c) => c.id === keepId || cardBelongsToCompany(c, company));
}
