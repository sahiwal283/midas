export interface PaymentMethodCompanyFields {
  defaultZohoEntity: string | null;
  zohoAccountName?: string | null;
}

function normalizeEntity(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

/** Cards for the company being viewed, plus cards with no company yet. */
export function groupPaymentMethodsForCompany<T extends PaymentMethodCompanyFields>(
  methods: T[],
  company: string,
): { belonging: T[]; unassigned: T[] } {
  const belonging: T[] = [];
  const unassigned: T[] = [];
  for (const method of methods) {
    const entity = normalizeEntity(method.defaultZohoEntity);
    if (!entity) unassigned.push(method);
    else if (entity === company) belonging.push(method);
  }
  return { belonging, unassigned };
}

/** Changing Zoho org invalidates the paid-through account id from the old org. */
export function patchForCompanyMove(
  method: PaymentMethodCompanyFields,
  nextEntity: string,
): { defaultZohoEntity: string | null; zohoAccountName?: null } {
  const next = normalizeEntity(nextEntity);
  const from = normalizeEntity(method.defaultZohoEntity);
  if (from === next) return { defaultZohoEntity: next };
  const patch: { defaultZohoEntity: string | null; zohoAccountName?: null } = {
    defaultZohoEntity: next,
  };
  if (method.zohoAccountName) patch.zohoAccountName = null;
  return patch;
}

/**
 * How many payment methods point at each Zoho paid-through account.
 *
 * Several cards legitimately settle to one account — three physical PNC cards
 * on one PNC credit line, for example — so the mapping is many-to-one. This
 * count is what lets the UI say so when you pick an account.
 */
export function countCardsPerZohoAccount(
  methods: Array<{ zohoAccountName: string | null }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of methods) {
    const id = m.zohoAccountName;
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Hint text for one account option, or null when there is nothing to say.
 *
 * `currentValue` is the mapping of the card being edited, so its own claim on
 * an account is not reported back to it as if someone else held it.
 */
export function shareHintFor(
  counts: Map<string, number>,
  accountId: string,
  currentValue: string | null,
): string | null {
  const total = counts.get(accountId) ?? 0;
  if (total === 0) return null;

  if (currentValue === accountId) {
    const others = total - 1;
    if (others <= 0) return null;
    return `also on ${others} other card${others === 1 ? '' : 's'}`;
  }
  return `already on ${total} card${total === 1 ? '' : 's'}`;
}
