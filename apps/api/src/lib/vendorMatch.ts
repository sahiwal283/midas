/**
 * Pure matching for Zoho Books vendors (no env/db imports — unit-testable).
 * Exact name match, case-insensitive and whitespace-trimmed. Deliberately no
 * fuzzy matching: attaching spend to the wrong vendor is worse than creating
 * a duplicate vendor an accountant can merge later.
 */

export interface ZohoVendorLike {
  id: string;
  name: string;
}

export function matchVendorByName(vendors: ZohoVendorLike[], merchant: string): string | null {
  const target = merchant.trim().toLowerCase();
  if (!target) return null;
  return vendors.find((v) => v.name.trim().toLowerCase() === target)?.id ?? null;
}
