/**
 * Map Midas zohoEntity (human label) → Zoho Integration Service X-Brand slug.
 * Brand grants are per-app on the integration service; unknown entities fall back
 * to ZOHO_DEFAULT_BRAND only when explicitly requested via resolveBrand(..., { fallback: true }).
 */

export interface ZohoEntityOption {
  /** Value stored on expenses.zoho_entity */
  entity: string;
  /** X-Brand header value for the integration service */
  brand: string;
}

/** Known accounting entities used by Haute / Trade Show cards. */
export const ZOHO_ENTITY_OPTIONS: ZohoEntityOption[] = [
  { entity: 'Haute Brands', brand: 'haute_brands' },
  { entity: 'Boomin Brands', brand: 'boomin_brands' },
  { entity: 'Nirvana Kulture', brand: 'nirvana_kulture' },
  { entity: 'Summitt Labs', brand: 'summitt_labs' },
];

const BY_ENTITY = new Map(
  ZOHO_ENTITY_OPTIONS.map((o) => [o.entity.toLowerCase(), o]),
);
const BY_BRAND = new Map(
  ZOHO_ENTITY_OPTIONS.map((o) => [o.brand.toLowerCase(), o]),
);

export function resolveBrandFromEntity(zohoEntity: string | null | undefined): string | null {
  if (!zohoEntity?.trim()) return null;
  const key = zohoEntity.trim().toLowerCase();
  const byEntity = BY_ENTITY.get(key);
  if (byEntity) return byEntity.brand;
  // Allow passing the brand slug itself as zohoEntity.
  if (BY_BRAND.has(key)) return key;
  // Slugify free text: "Haute Brands" already covered; "haute-brands" → haute_brands
  const slug = key.replace(/[\s-]+/g, '_');
  if (BY_BRAND.has(slug)) return slug;
  return null;
}

export function listZohoEntities(): ZohoEntityOption[] {
  return [...ZOHO_ENTITY_OPTIONS];
}
