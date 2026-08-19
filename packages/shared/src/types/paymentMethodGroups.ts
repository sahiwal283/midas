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
