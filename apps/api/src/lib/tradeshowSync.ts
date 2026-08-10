// Pure helpers for the one-off Trade Show → Midas reconciliation
// (scripts/sync-tradeshow-data.ts). Kept separate so they're unit-testable.

const ROLE_MAP: Record<string, 'user' | 'accountant' | 'admin' | 'partner' | 'developer'> = {
  developer: 'developer',
  admin: 'admin',
  accountant: 'accountant',
  // User decision 2026-08-10: no Midas equivalent — both become standard users.
  salesperson: 'user',
  coordinator: 'user',
};

export function mapTradeShowRole(tsRole: string): 'user' | 'accountant' | 'admin' | 'partner' | 'developer' {
  const mapped = ROLE_MAP[tsRole];
  if (!mapped) throw new Error(`No Midas role mapping for trade show role "${tsRole}"`);
  return mapped;
}

/** Trade show "Storage charges" ids are polluted ("Haute: 525..."). Extract the numeric id. */
export function cleanZohoAccountId(raw: string): string | null {
  const match = raw.match(/\d{10,}/);
  return match ? match[0] : null;
}

export const ENTITY_COMPANY_MAP: Record<string, string> = {
  haute_brands: 'Haute Brands',
  boomin_brands: 'Boomin Brands',
  nirvana_kulture: 'Nirvana Kulture',
};
