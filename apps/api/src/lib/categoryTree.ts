// Pure tree helpers for hierarchical expense categories (adjacency list).
// All functions take a flat node array — no DB access — so they are trivially testable.

export interface CategoryNode {
  id: string;
  parentId: string | null;
  isActive: boolean;
}

function byId(nodes: CategoryNode[]): Map<string, CategoryNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

/** [id, parent, …, root]. Bounded by nodes.length so malformed cycles cannot hang. */
export function ancestryChain(nodes: CategoryNode[], id: string): string[] {
  const map = byId(nodes);
  const chain: string[] = [];
  let cur: string | null = id;
  while (cur && map.has(cur) && chain.length < nodes.length) {
    if (chain.includes(cur)) break;
    chain.push(cur);
    cur = map.get(cur)!.parentId;
  }
  return chain;
}

export function topLevelAncestorId(nodes: CategoryNode[], id: string): string {
  const chain = ancestryChain(nodes, id);
  return chain[chain.length - 1] ?? id;
}

/** True if setting `id`.parentId = newParentId would create a cycle (self-parent included). */
export function wouldCreateCycle(nodes: CategoryNode[], id: string, newParentId: string | null): boolean {
  if (!newParentId) return false;
  if (newParentId === id) return true;
  return ancestryChain(nodes, newParentId).includes(id);
}

/** rootId plus every descendant, breadth-first. */
export function descendantIds(nodes: CategoryNode[], rootId: string): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.parentId) continue;
    childrenOf.set(n.parentId, [...(childrenOf.get(n.parentId) ?? []), n.id]);
  }
  const out: string[] = [];
  const queue = [rootId];
  while (queue.length && out.length <= nodes.length) {
    const cur = queue.shift()!;
    if (out.includes(cur)) continue;
    out.push(cur);
    queue.push(...(childrenOf.get(cur) ?? []));
  }
  return out;
}

/** Ids active in themselves AND in every ancestor. */
export function effectivelyActiveIds(nodes: CategoryNode[]): Set<string> {
  const map = byId(nodes);
  const active = new Set<string>();
  for (const n of nodes) {
    const chain = ancestryChain(nodes, n.id);
    if (chain.every((id) => map.get(id)?.isActive)) active.add(n.id);
  }
  return active;
}

/** Roll spend rows up to their top-level ancestor. Rows with null categoryId stay "Uncategorized". */
export function rollUpByTopAncestor(
  nodes: CategoryNode[],
  rows: { categoryId: string | null; spend: number; n: number }[],
  nameOf: (id: string) => string,
): { name: string; spend: number; n: number }[] {
  const acc = new Map<string, { name: string; spend: number; n: number }>();
  for (const r of rows) {
    const key = r.categoryId ? topLevelAncestorId(nodes, r.categoryId) : '__uncategorized__';
    const name = r.categoryId ? nameOf(key) : 'Uncategorized';
    const cur = acc.get(key) ?? { name, spend: 0, n: 0 };
    cur.spend += r.spend;
    cur.n += r.n;
    acc.set(key, cur);
  }
  return [...acc.values()].sort((a, b) => b.spend - a.spend);
}
