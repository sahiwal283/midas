export interface CategoryTreeNode {
  id: string;
  name: string;
  parentId: string | null;
}

export function buildChildrenMap<T extends CategoryTreeNode>(cats: T[]): Map<string | null, T[]> {
  const map = new Map<string | null, T[]>();
  for (const c of cats) {
    const key = c.parentId ?? null;
    map.set(key, [...(map.get(key) ?? []), c]);
  }
  for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return map;
}

/** [rootId, …, id]; bounded against malformed cycles. */
export function pathFromRoot(cats: CategoryTreeNode[], id: string): string[] {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const path: string[] = [];
  let cur: string | null = id;
  while (cur && byId.has(cur) && path.length < cats.length) {
    if (path.includes(cur)) break;
    path.unshift(cur);
    cur = byId.get(cur)!.parentId ?? null;
  }
  return path;
}

/** Depth-first flatten for indented rendering: [{ cat, depth }] in tree order. */
export function flattenTree<T extends CategoryTreeNode>(cats: T[]): { cat: T; depth: number }[] {
  const children = buildChildrenMap(cats);
  const out: { cat: T; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    if (depth > cats.length) return;
    for (const c of children.get(parentId) ?? []) {
      out.push({ cat: c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** id plus every descendant id. */
export function descendantIdSet(cats: CategoryTreeNode[], rootId: string): Set<string> {
  const allowed = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of cats) {
      if (c.parentId && allowed.has(c.parentId) && !allowed.has(c.id)) {
        allowed.add(c.id);
        grew = true;
      }
    }
  }
  return allowed;
}
