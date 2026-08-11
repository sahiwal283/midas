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
