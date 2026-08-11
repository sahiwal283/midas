/**
 * Per-connection category vocabulary — pure helpers (no env/db imports),
 * mirroring the closedPeriods.ts / closedPeriodsDb.ts split.
 *
 * An empty allowlist means "unrestricted": the connection sees every active
 * category. That keeps existing integrations working until an admin scopes them,
 * and means a brand-new connection is never accidentally blank.
 */

/** Apply an allowlist (null = unrestricted) to a category list. */
export function applyVocabulary<T extends { id: string }>(
  categories: T[],
  allowed: Set<string> | null,
): T[] {
  if (!allowed) return categories;
  return categories.filter((c) => allowed.has(c.id));
}
