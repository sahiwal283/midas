/**
 * Pure matching for Zoho Books vendors (no env/db imports — unit-testable).
 * Names are compared through normalizeMerchant, so case, punctuation, card-
 * processor decorations ("WAL-MART #1234") and known aliases all collapse to
 * one vendor. Anything beyond that normalization is deliberately NOT fuzzy:
 * attaching spend to the wrong vendor is worse than creating a duplicate an
 * accountant can merge later.
 */

import { normalizeMerchant } from './merchants';

export interface ZohoVendorLike {
  id: string;
  name: string;
}

/** Shared dedup key: two names with the same key are the same vendor. */
export function vendorKey(name: string): string {
  return normalizeMerchant(name).toLowerCase();
}

export function matchVendorByName(vendors: ZohoVendorLike[], merchant: string): string | null {
  if (!merchant.trim()) return null;
  const target = vendorKey(merchant);
  if (!target) return null;
  return vendors.find((v) => vendorKey(v.name) === target)?.id ?? null;
}
