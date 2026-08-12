/**
 * Resolves the effective [from, to] window for the summary endpoint when the
 * caller omits either bound. `bounds` is the min/max `date` across all
 * partner-kind expenses (null/null when there are none). Explicit values win
 * over bounds; when a value is still unresolved (missing param AND no rows
 * to fall back to) the result is `null`, meaning "nothing to summarise".
 */
export function effectiveDateRange(
  from: string | undefined,
  to: string | undefined,
  bounds: { min: string | null; max: string | null },
): { from: string; to: string } | null {
  const effectiveFrom = from ?? bounds.min ?? undefined;
  const effectiveTo = to ?? bounds.max ?? undefined;
  if (!effectiveFrom || !effectiveTo) return null;
  return { from: effectiveFrom, to: effectiveTo };
}

/** Pure aggregation for the partner expense charts (no db/env imports). */
export function summarisePartnerRows(
  rows: Array<{ key: string | null; spend: number; count: number }>,
  nameOf: (key: string) => string,
): Array<{ name: string; spend: number; count: number }> {
  const acc = new Map<string, { name: string; spend: number; count: number }>();
  for (const r of rows) {
    const k = r.key ?? '__unassigned__';
    const name = r.key ? nameOf(r.key) : 'Unassigned';
    const cur = acc.get(k) ?? { name, spend: 0, count: 0 };
    cur.spend += r.spend;
    cur.count += r.count;
    acc.set(k, cur);
  }
  return [...acc.values()].sort((a, b) => b.spend - a.spend);
}
